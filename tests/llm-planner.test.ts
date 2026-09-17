import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { LLMPlanner } from "../src/agents/llm-planner.js";
import { MultiAgent } from "../src/agents/multi-agent.js";
import { DeterministicPlanner } from "../src/agents/deterministic-planner.js";
import type { Agent } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { AgentDescriptor } from "../src/agents/descriptor.js";
import type { AgentEvent } from "../src/agents/events.js";
import type { AgentResult } from "../src/agents/result.js";
import type { Message } from "../src/chat/message.js";
import type { PlannerInput } from "../src/agents/planner-input.js";
import type { LLMClient } from "../src/llm/client.js";

/** Fake LLM answering planner prompts with a canned output. */
class FakePlannerLLM implements LLMClient {
  received: Message[][] = [];

  constructor(private readonly output: string) {}

  async *stream(_messages: Message[]): AsyncGenerator<string> {
    throw new Error("LLMPlanner tests never stream");
  }

  async complete(messages: Message[]): Promise<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    return this.output;
  }
}

/** Minimal fake child agent for the integration test. */
class FakeAgent implements Agent {
  calls: { input: string; context: AgentContext }[] = [];

  constructor(readonly descriptor: AgentDescriptor) {}

  run(input: string, context: AgentContext) {
    this.calls.push({ input, context });
    const name = this.descriptor.name;
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "agent_start", agent: name };
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end" };
      yield { type: "agent_end", agent: name };
    }
    return {
      events: events(),
      result: Promise.resolve({ messages: [] as Message[] }),
    };
  }
}

function makeContext(): AgentContext {
  return { conversation: new Conversation(), previousResults: [] };
}

function planInput(
  input: string,
  messages: PlannerInput["messages"] = [],
): PlannerInput {
  return {
    input,
    messages,
    agents: [
      { name: "general", description: "General test agent." },
      { name: "research", description: "Research test agent." },
    ],
  };
}

describe("LLMPlanner", () => {
  it.each([
    ["general", "general"],
    ["research", "research"],
    [" RESEARCH ", "research"],
    ["General", "general"],
    ["\nresearch\n", "research"],
  ])("plans model output %j as %s", async (output, expected) => {
    const planner = new LLMPlanner(new FakePlannerLLM(output));

    await expect(
      planner.plan(planInput("anything")),
    ).resolves.toEqual({ agents: [expected] });
  });

  it.each([["something else"], [""], ["I recommend research"], ["researcher"]])(
    "rejects model output %j",
    async (output) => {
      const planner = new LLMPlanner(new FakePlannerLLM(output));

      await expect(
        planner.plan(planInput("anything")),
      ).rejects.toThrow(/Invalid planner output/);
    },
  );

  it.each([
    ["research,general", ["research", "general"]],
    ["general", ["general"]],
    [" Research , GENERAL ", ["research", "general"]],
  ])("plans multi-agent output %j as %j", async (output, expected) => {
    const planner = new LLMPlanner(new FakePlannerLLM(output));

    await expect(
      planner.plan(planInput("anything")),
    ).resolves.toEqual({ agents: expected });
  });

  it.each([["research,,general"], ["research\ngeneral"], [","]])(
    "rejects malformed list output %j",
    async (output) => {
      const planner = new LLMPlanner(new FakePlannerLLM(output));

      await expect(
        planner.plan(planInput("anything")),
      ).rejects.toThrow(/Invalid planner output/);
    },
  );

  it("sends the system prompt and the user input to the LLM", async () => {
    const llm = new FakePlannerLLM("general");
    const planner = new LLMPlanner(llm);

    await planner.plan(planInput("deep question"));

    expect(llm.received).toHaveLength(1);
    expect(llm.received[0]).toEqual([
      { role: "system", content: expect.stringContaining("general") },
      { role: "user", content: "deep question" },
    ]);
  });

  it("forwards history and input without duplicating the input", async () => {
    const llm = new FakePlannerLLM("research");
    const planner = new LLMPlanner(llm);

    await planner.plan(
      planInput("research this further", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    );

    expect(llm.received).toHaveLength(1);
    expect(llm.received[0]).toEqual([
      { role: "system", content: expect.stringContaining("general") },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "research this further" },
    ]);
    // Current input appears exactly once.
    expect(
      llm.received[0]?.filter((m) => m.content === "research this further"),
    ).toHaveLength(1);
  });

  it("does not mutate the supplied PlannerInput", async () => {
    const llm = new FakePlannerLLM("general");
    const planner = new LLMPlanner(llm);
    const input: PlannerInput = {
      input: "hello",
      messages: [{ role: "user", content: "before" }],
      agents: [{ name: "general", description: "General test agent." }],
    };

    await planner.plan(input);

    expect(input).toEqual({
      input: "hello",
      messages: [{ role: "user", content: "before" }],
      agents: [{ name: "general", description: "General test agent." }],
    });
  });

  it("builds the prompt from the supplied descriptors, not hardcoded text", async () => {
    const llm = new FakePlannerLLM("coder");
    const planner = new LLMPlanner(llm);

    await planner.plan({
      input: "write code",
      messages: [],
      agents: [
        { name: "general", description: "General custom description." },
        { name: "coder", description: "Writes code on demand." },
      ],
    });

    expect(llm.received).toHaveLength(1);
    const system = llm.received[0]?.[0]?.content ?? "";
    expect(system).toContain("General custom description.");
    expect(system).toContain("Writes code on demand.");
    // No trace of the old hardcoded routing copy.
    expect(system).not.toContain("ordinary conversation");
    expect(system).not.toContain("research or investigation");
  });

  it("accepts a nonstandard name when the descriptors offer it", async () => {
    const planner = new LLMPlanner(new FakePlannerLLM("coder"));

    await expect(
      planner.plan({
        input: "write code",
        messages: [],
        agents: [{ name: "coder", description: "Writes code on demand." }],
      }),
    ).resolves.toEqual({ agents: ["coder"] });
  });

  it("rejects a known word that the descriptors do not offer", async () => {
    const planner = new LLMPlanner(new FakePlannerLLM("research"));

    await expect(
      planner.plan({
        input: "write code",
        messages: [],
        agents: [{ name: "coder", description: "Writes code on demand." }],
      }),
    ).rejects.toThrow(/Invalid planner output/);
  });

  it("returns only a Plan", async () => {
    const planner = new LLMPlanner(new FakePlannerLLM("research"));

    const plan = await planner.plan(planInput("x"));

    expect(Object.keys(plan)).toEqual(["agents"]);
  });

  it("does not modify the input", async () => {
    const planner = new LLMPlanner(new FakePlannerLLM("general"));
    const input = "hello";

    await planner.plan(planInput(input));

    expect(input).toBe("hello");
  });
});

describe("MultiAgent with LLMPlanner", () => {
  it("routes through the Planner contract without knowing the implementation", async () => {
    const general = new FakeAgent({ name: "general", description: "General test agent." });
    const research = new FakeAgent({ name: "research", description: "Research test agent." });
    const agent = new MultiAgent(
      { general, research },
      new LLMPlanner(new FakePlannerLLM("research")),
    );
    const context = makeContext();

    const run = agent.run("hello", context);
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
    }
    const result: AgentResult = await run.result;

    // Plain input routed to research purely because the planner said so —
    // MultiAgent holds no routing logic of its own.
    expect(research.calls).toHaveLength(1);
    expect(general.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "agent_start", agent: "research" },
      { type: "message_start", role: "assistant" },
      { type: "message_end" },
      { type: "agent_end", agent: "research" },
    ]);
    expect(result).toEqual({ messages: [] });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("presents all offered agents dynamically and routes coder output to coder", async () => {
    const planningLLM = new FakePlannerLLM("coder");
    const general = new FakeAgent({ name: "general", description: "General test agent." });
    const research = new FakeAgent({ name: "research", description: "Research test agent." });
    const coder = new FakeAgent({ name: "coder", description: "Writes and explains code." });
    const agent = new MultiAgent(
      { general, research, coder },
      new LLMPlanner(planningLLM),
    );
    const context = makeContext();

    const run = agent.run("write a function", context);
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
    }
    await run.result;

    // Prompt built from the supplied descriptors — nothing hardcoded.
    expect(planningLLM.received).toHaveLength(1);
    const system = planningLLM.received[0]?.[0]?.content ?? "";
    expect(system).toContain("General test agent.");
    expect(system).toContain("Research test agent.");
    expect(system).toContain("Writes and explains code.");

    // The coder child actually executes with its own lifecycle.
    expect(coder.calls).toHaveLength(1);
    expect(general.calls).toHaveLength(0);
    expect(research.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "agent_start", agent: "coder" },
      { type: "message_start", role: "assistant" },
      { type: "message_end" },
      { type: "agent_end", agent: "coder" },
    ]);
  });

  it("gives the turn-2 planner the turn-1 history plus the current input exactly once", async () => {
    const planningLLM = new FakePlannerLLM("general");
    const agent = new MultiAgent(
      { general: new FakeAgent({ name: "general", description: "General test agent." }), research: new FakeAgent({ name: "research", description: "Research test agent." }) },
      new LLMPlanner(planningLLM),
    );
    const context = makeContext();

    for (const input of ["hello", "research that"]) {
      const run = agent.run(input, context);
      for await (const _event of run.events) {
        // Drain events; publication completes via the result contract.
      }
      await run.result;
    }

    expect(planningLLM.received).toHaveLength(2);
    // Turn 2 planning request = turn 1 history + turn 2 input, no duplication.
    expect(planningLLM.received[1]).toEqual([
      { role: "system", content: expect.stringContaining("general") },
      { role: "user", content: "hello" },
      { role: "user", content: "research that" },
    ]);
    expect(
      planningLLM.received[1]?.filter((m) => m.content === "research that"),
    ).toHaveLength(1);
  });
});

describe("MultiAgent with DeterministicPlanner", () => {
  it("records multi-turn root history without duplication", async () => {
    const agent = new MultiAgent(
      { general: new FakeAgent({ name: "general", description: "General test agent." }), research: new FakeAgent({ name: "research", description: "Research test agent." }) },
      new DeterministicPlanner(),
    );
    const context = makeContext();

    for (const input of ["hello", "/research x"]) {
      const run = agent.run(input, context);
      for await (const _event of run.events) {
        // Drain.
      }
      await run.result;
    }

    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "/research x" },
    ]);
  });
});
