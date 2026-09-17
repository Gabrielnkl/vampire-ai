import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { MultiAgent } from "../src/agents/multi-agent.js";
import { DeterministicPlanner } from "../src/agents/deterministic-planner.js";
import type { Planner } from "../src/agents/planner.js";
import type { AgentName, Plan } from "../src/agents/plan.js";
import type { AgentDescriptor } from "../src/agents/descriptor.js";
import type { Message } from "../src/chat/message.js";
import type { PlannerInput } from "../src/agents/planner-input.js";
import type { Agent, AgentRun } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { AgentEvent } from "../src/agents/events.js";
import type { AgentResult } from "../src/agents/result.js";

/**
 * Fake child agent emitting recognizable lifecycle-bracketed events and
 * recording its calls. Mimics SingleAgent: agent_start … agent_end around
 * message events, error-as-event without message_end on failure, and a
 * result contract matching the streamed output.
 */
class FakeAgent implements Agent {
  calls: { input: string; context: AgentContext }[] = [];

  constructor(
    readonly descriptor: AgentDescriptor,
    private readonly tag: string,
    private readonly fail = false,
  ) {}

  run(input: string, context: AgentContext): AgentRun {
    this.calls.push({ input, context });
    const tag = this.tag;
    const name = this.descriptor.name;
    const fail = this.fail;
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "agent_start", agent: name };
      try {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: tag };
        if (fail) {
          yield { type: "error", error: new Error("child blew up") };
          return;
        }
        yield { type: "message_end" };
      } finally {
        yield { type: "agent_end", agent: name };
      }
    }
    return {
      events: events(),
      result: Promise.resolve(
        fail ? { messages: [] } : { messages: [{ role: "assistant", content: tag }] },
      ),
    };
  }
}

function makeContext(): AgentContext {
  return { conversation: new Conversation(), previousResults: [] };
}

const GENERAL_DESCRIPTOR: AgentDescriptor = {
  name: "general",
  description: "General test agent.",
};

const RESEARCH_DESCRIPTOR: AgentDescriptor = {
  name: "research",
  description: "Research test agent.",
};

const CODER_DESCRIPTOR: AgentDescriptor = {
  name: "coder",
  description: "Writes and explains code.",
};

function makeAgents(): { general: FakeAgent; research: FakeAgent; coder: FakeAgent } {
  return {
    general: new FakeAgent(GENERAL_DESCRIPTOR, "GENERAL"),
    research: new FakeAgent(RESEARCH_DESCRIPTOR, "RESEARCH"),
    coder: new FakeAgent(CODER_DESCRIPTOR, "CODER"),
  };
}

/** Scriptable planner recording the PlannerInputs it receives. */
class FixedPlanner implements Planner {
  calls: PlannerInput[] = [];

  constructor(private readonly agents: AgentName[]) {}

  plan(input: PlannerInput): Promise<Plan> {
    this.calls.push({
      input: input.input,
      messages: input.messages.map((m) => ({ ...m })),
      agents: input.agents.map((a) => ({ ...a })),
    });
    return Promise.resolve({ agents: [...this.agents] });
  }
}

async function collect(
  agent: Agent,
  context: AgentContext,
  input: string,
): Promise<{ events: AgentEvent[]; result: AgentResult }> {
  const run = agent.run(input, context);
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return { events, result: await run.result };
}

describe("MultiAgent", () => {
  it("is itself an Agent", () => {
    const children = makeAgents();
    const agent: Agent = new MultiAgent(children, new DeterministicPlanner());
    expect(agent.descriptor).toEqual({
      name: "multi",
      description: "Routes each request to exactly one child agent.",
    });
    expect(typeof agent.run).toBe("function");
  });

  it("emits no lifecycle events of its own", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());

    const { events } = await collect(agent, makeContext(), "hello");

    // Only the selected concrete child's identity appears.
    expect(
      events.filter((e) => e.type === "agent_start" || e.type === "agent_end"),
    ).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "agent_end", agent: "general" },
    ]);
  });

  it("exposes all three child descriptors to the planner", async () => {
    const children = makeAgents();
    const planner = new FixedPlanner(["general"]);
    const agent = new MultiAgent(children, planner);
    const context = makeContext();

    await collect(agent, context, "hello");

    // Descriptors come from the actual children — no separate hardcoded list.
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]?.agents).toEqual([
      children.general.descriptor,
      children.research.descriptor,
      children.coder.descriptor,
    ]);
    expect(planner.calls[0]?.agents.map((a) => a.name)).toEqual([
      "general",
      "research",
      "coder",
    ]);
  });

  it("executes the coder child when the planner selects it", async () => {
    const children = makeAgents();
    const planner = new FixedPlanner(["coder"]);
    const agent = new MultiAgent(children, planner);
    const context = makeContext();

    const { events, result } = await collect(agent, context, "write code");

    expect(children.coder.calls).toHaveLength(1);
    expect(children.general.calls).toHaveLength(0);
    expect(children.research.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "agent_start", agent: "coder" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "CODER" },
      { type: "message_end" },
      { type: "agent_end", agent: "coder" },
    ]);
    expect(result).toEqual({
      messages: [{ role: "assistant", content: "CODER" }],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "write code" },
      { role: "assistant", content: "CODER" },
    ]);
  });

  it("executes planned agents sequentially in plan order", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(
      children,
      new FixedPlanner(["research", "general"]),
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "both");

    // Research runs to completion before general starts — never interleaved.
    expect(events).toEqual([
      { type: "agent_start", agent: "research" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "RESEARCH" },
      { type: "message_end" },
      { type: "agent_end", agent: "research" },
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "GENERAL" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
    expect(children.research.calls).toHaveLength(1);
    expect(children.general.calls).toHaveLength(1);
    expect(children.coder.calls).toHaveLength(0);
  });

  it("collects ordered child results without reconstructing them from events", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(
      children,
      new FixedPlanner(["research", "general"]),
    );
    const context = makeContext();

    const { result } = await collect(agent, context, "both");

    expect(result).toEqual({
      messages: [
        { role: "assistant", content: "RESEARCH" },
        { role: "assistant", content: "GENERAL" },
      ],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "both" },
      { role: "assistant", content: "RESEARCH" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("gives each child exactly the results completed before it started", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(
      children,
      new FixedPlanner(["general", "research", "coder"]),
    );
    const context = makeContext();

    await collect(agent, context, "chain");

    const generalSeen = children.general.calls[0]?.context.previousResults ?? [];
    const researchSeen = children.research.calls[0]?.context.previousResults ?? [];
    const coderSeen = children.coder.calls[0]?.context.previousResults ?? [];
    expect(generalSeen).toEqual([]);
    expect(researchSeen).toEqual([
      { messages: [{ role: "assistant", content: "GENERAL" }] },
    ]);
    expect(coderSeen).toEqual([
      { messages: [{ role: "assistant", content: "GENERAL" }] },
      { messages: [{ role: "assistant", content: "RESEARCH" }] },
    ]);
  });

  it("isolates previousResults snapshots between children at runtime", async () => {
    const seen: AgentResult[][] = [];
    const corrupting: Agent = {
      descriptor: { name: "research", description: "Research test agent." },
      run(_input: string, childContext: AgentContext): AgentRun {
        seen.push(childContext.previousResults.map((r) => ({ ...r })));
        // Deliberate cast: simulates a malicious/buggy JS child bypassing
        // the readonly types. Array-level attacks must not leak across
        // siblings; result objects themselves stay shared by convention.
        const writable = childContext.previousResults as AgentResult[];
        writable.push({ messages: [{ role: "assistant", content: "fake" }] });
        writable[0] = { messages: [{ role: "assistant", content: "fake" }] };
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "research" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "RESEARCH" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "research" };
        }
        return {
          events: events(),
          result: Promise.resolve({
            messages: [{ role: "assistant", content: "RESEARCH" }],
          }),
        };
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(
      { ...children, research: corrupting },
      new FixedPlanner(["general", "research", "coder"]),
    );
    const context = makeContext();

    await collect(agent, context, "chain");

    // The corrupting child saw [GENERAL]; its push/replace hit only its own
    // array. Coder still sees the pristine sequence.
    expect(seen).toHaveLength(1);
    expect(children.coder.calls[0]?.context.previousResults).toEqual([
      { messages: [{ role: "assistant", content: "GENERAL" }] },
      { messages: [{ role: "assistant", content: "RESEARCH" }] },
    ]);
    // Root publication used settled results, never the corrupted array.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "chain" },
      { role: "assistant", content: "GENERAL" },
      { role: "assistant", content: "RESEARCH" },
      { role: "assistant", content: "CODER" },
    ]);
  });

  it("passes authoritative results, not streamed text, to the next child", async () => {
    const seen: AgentResult[][] = [];
    const diverging: Agent = {
      descriptor: { name: "general", description: "General test agent." },
      run(): AgentRun {
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "general" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "streamed UI text" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "general" };
        }
        return {
          events: events(),
          result: Promise.resolve({
            messages: [{ role: "assistant", content: "published result" }],
          }),
        };
      },
    };
    const recording: Agent = {
      descriptor: { name: "research", description: "Research test agent." },
      run(_input: string, childContext: AgentContext): AgentRun {
        seen.push([...childContext.previousResults]);
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "research" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "research" };
        }
        return { events: events(), result: Promise.resolve({ messages: [] }) };
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(
      { ...children, general: diverging, research: recording },
      new FixedPlanner(["general", "research"]),
    );
    const context = makeContext();

    await collect(agent, context, "go");

    expect(seen).toEqual([
      [{ messages: [{ role: "assistant", content: "published result" }] }],
    ]);
  });

  it("exposes failed children as empty results without stopping the plan", async () => {
    const seen: AgentResult[][] = [];
    const recording: Agent = {
      descriptor: { name: "coder", description: "Writes and explains code." },
      run(_input: string, childContext: AgentContext): AgentRun {
        seen.push([...childContext.previousResults]);
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "coder" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "coder" };
        }
        return { events: events(), result: Promise.resolve({ messages: [] }) };
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(
      {
        general: new FakeAgent(GENERAL_DESCRIPTOR, "GENERAL"),
        research: new FakeAgent(RESEARCH_DESCRIPTOR, "RESEARCH", true),
        coder: recording,
      },
      new FixedPlanner(["general", "research", "coder"]),
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "chain");

    // Research failed: its error event is forwarded, its partial text is
    // nowhere, and the plan continues with only settled results visible.
    // (`seen` non-empty proves the coder child ran after the failure.)
    expect(seen).toEqual([
      [
        { messages: [{ role: "assistant", content: "GENERAL" }] },
        { messages: [] },
      ],
    ]);
    expect(events.some((e) => e.type === "message_end")).toBe(true);
    expect(result).toEqual({
      messages: [{ role: "assistant", content: "GENERAL" }],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "chain" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("executes the same child twice for a duplicated plan entry", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(
      children,
      new FixedPlanner(["research", "research"]),
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "again");

    // No deduplication: the plan is an execution order, not a set.
    expect(children.research.calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "agent_start")).toEqual([
      { type: "agent_start", agent: "research" },
      { type: "agent_start", agent: "research" },
    ]);
    expect(result).toEqual({
      messages: [
        { role: "assistant", content: "RESEARCH" },
        { role: "assistant", content: "RESEARCH" },
      ],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "again" },
      { role: "assistant", content: "RESEARCH" },
      { role: "assistant", content: "RESEARCH" },
    ]);
  });

  it("executes nothing when a later plan entry is unknown", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(
      children,
      new FixedPlanner(["research", "does-not-exist"]),
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "hello");

    // Full-plan validation happens before the first child starts.
    expect(children.research.calls).toHaveLength(0);
    expect(children.general.calls).toHaveLength(0);
    expect(children.coder.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "error", error: new Error('Unknown agent: "does-not-exist"') },
    ]);
    expect(result).toEqual({ messages: [] });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("executes nothing for an empty plan", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new FixedPlanner([]));
    const context = makeContext();

    const { events, result } = await collect(agent, context, "hello");

    expect(children.general.calls).toHaveLength(0);
    expect(children.research.calls).toHaveLength(0);
    expect(children.coder.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "error", error: new Error("Invalid plan: no agents selected") },
    ]);
    expect(result).toEqual({ messages: [] });
    expect(context.conversation.getMessages()).toEqual([]);
  });

  it("keeps completed children published when a later child fails", async () => {
    const agent = new MultiAgent(
      {
        general: new FakeAgent(GENERAL_DESCRIPTOR, "GENERAL"),
        research: new FakeAgent(RESEARCH_DESCRIPTOR, "RESEARCH", true),
        coder: new FakeAgent(CODER_DESCRIPTOR, "CODER"),
      },
      new FixedPlanner(["general", "research"]),
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "both");

    // General completed and stays published; research failed without a
    // fabricated message. No rollback, no pretending.
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "message_start",
      "text_delta",
      "message_end",
      "agent_end",
      "agent_start",
      "message_start",
      "text_delta",
      "error",
      "agent_end",
    ]);
    expect(result).toEqual({
      messages: [{ role: "assistant", content: "GENERAL" }],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "both" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("routes plain input to the general agent", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    const { events } = await collect(agent, context, "hello");

    expect(children.general.calls).toHaveLength(1);
    expect(children.research.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "GENERAL" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
  });

  it("routes /research input to the research agent", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    const { events } = await collect(agent, context, "/research TypeScript streams");

    expect(children.research.calls).toHaveLength(1);
    expect(children.general.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "agent_start", agent: "research" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "RESEARCH" },
      { type: "message_end" },
      { type: "agent_end", agent: "research" },
    ]);
  });

  it("forwards the original input unchanged to the selected child", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    await collect(agent, context, "/research TypeScript streams");

    // Prefix preserved: the child/model sees exactly what the user typed.
    expect(children.research.calls[0]?.input).toBe(
      "/research TypeScript streams",
    );
  });

  it("gives the selected child a derived context, not the original", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    await collect(agent, context, "hello");
    await collect(agent, context, "/research x");

    const generalContext = children.general.calls[0]?.context;
    const researchContext = children.research.calls[0]?.context;
    expect(generalContext).toBeDefined();
    expect(researchContext).toBeDefined();
    expect(generalContext).not.toBe(context);
    expect(researchContext).not.toBe(context);
    expect(generalContext?.conversation).not.toBe(context.conversation);
    expect(researchContext?.conversation).not.toBe(context.conversation);
  });

  it("preloads the derived context with the parent messages at fork time", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();
    context.conversation.add("user", "earlier");
    context.conversation.add("assistant", "reply");

    await collect(agent, context, "hello");

    // Fork precedes the current turn: snapshot holds prior history, and the
    // FakeAgent child adds nothing itself.
    expect(
      children.general.calls[0]?.context.conversation.getMessages(),
    ).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("keeps child conversation mutations isolated from the parent", async () => {
    const mutating: Agent = {
      descriptor: GENERAL_DESCRIPTOR,
      run(
        _input: string,
        childContext: AgentContext,
      ): AgentRun {
        childContext.conversation.add("assistant", "child-only note");
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "general" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "general" };
        }
        return { events: events(), result: Promise.resolve({ messages: [] }) };
      },
    };
    const agent = new MultiAgent(
      {
        general: mutating,
        research: new FakeAgent({ name: "research", description: "Research test agent." }, "RESEARCH"),
      },
      new DeterministicPlanner(),
    );
    const context = makeContext();

    await collect(agent, context, "hello");

    // No automatic merge: the child's private note never reaches the root,
    // which records only the user-visible turn (empty response → user only).
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("records successful turns in the root conversation without duplicating", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    await collect(agent, context, "hello");
    await collect(agent, context, "/research x");

    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "GENERAL" },
      { role: "user", content: "/research x" },
      { role: "assistant", content: "RESEARCH" },
    ]);
  });

  it("records only the user message in the root conversation on child failure", async () => {
    const agent = new MultiAgent(
      {
        general: new FakeAgent({ name: "general", description: "General test agent." }, "GENERAL", true),
        research: new FakeAgent({ name: "research", description: "Research test agent." }, "RESEARCH"),
      },
      new DeterministicPlanner(),
    );
    const context = makeContext();

    const { events } = await collect(agent, context, "hello");

    expect(events.some((e) => e.type === "message_end")).toBe(false);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("runs only one child per input", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    await collect(agent, context, "hello");
    await collect(agent, context, "/research x");

    expect(children.general.calls).toHaveLength(1);
    expect(children.research.calls).toHaveLength(1);
  });

  it("forwards child events in exactly the same order", async () => {
    const childEvents: AgentEvent[] = [
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ];
    const passthrough: Agent = {
      descriptor: GENERAL_DESCRIPTOR,
      run(): AgentRun {
        async function* events(): AsyncGenerator<AgentEvent> {
          yield* childEvents;
        }
        return { events: events(), result: Promise.resolve({ messages: [] }) };
      },
    };
    const agent = new MultiAgent(
      {
        general: passthrough,
        research: new FakeAgent({ name: "research", description: "Research test agent." }, "RESEARCH"),
      },
      new DeterministicPlanner(),
    );

    expect((await collect(agent, makeContext(), "hello")).events).toEqual(childEvents);
  });

  it("forwards a child failure unchanged with no message_end", async () => {
    const failure = new Error("child blew up");
    const failing: Agent = {
      descriptor: GENERAL_DESCRIPTOR,
      run(): AgentRun {
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "general" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "partial-" };
          yield { type: "error", error: failure };
          yield { type: "agent_end", agent: "general" };
        }
        return { events: events(), result: Promise.resolve({ messages: [] }) };
      },
    };
    const agent = new MultiAgent(
      {
        general: failing,
        research: new FakeAgent({ name: "research", description: "Research test agent." }, "RESEARCH"),
      },
      new DeterministicPlanner(),
    );

    const { events } = await collect(agent, makeContext(), "hello");

    expect(events).toHaveLength(5);
    expect(events[3]).toEqual({ type: "error", error: failure });
    expect((events[3] as { error: Error }).error).toBe(failure);
    expect(events.some((e) => e.type === "message_end")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "agent_end", agent: "general" });
  });

  it("publishes the child's result, not the streamed text, into the root conversation", async () => {
    // Boundary proof: events carry one thing, the result carries another.
    // MultiAgent must use the result contract for state propagation while
    // the event stream keeps driving the UI.
    const diverging: Agent = {
      descriptor: RESEARCH_DESCRIPTOR,
      run(): AgentRun {
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "research" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "streamed UI text" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "research" };
        }
        return {
          events: events(),
          result: Promise.resolve({
            messages: [{ role: "assistant", content: "published result" }],
          }),
        };
      },
    };
    const agent = new MultiAgent(
      {
        general: new FakeAgent({ name: "general", description: "General test agent." }, "GENERAL"),
        research: diverging,
      },
      new DeterministicPlanner(),
    );
    const context = makeContext();

    const { events, result } = await collect(
      agent,
      context,
      "/research boundary",
    );

    // UI/event stream still receives the streamed text.
    expect(
      events.filter((e) => e.type === "text_delta"),
    ).toEqual([{ type: "text_delta", text: "streamed UI text" }]);

    // Root conversation receives the published result instead.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "/research boundary" },
      { role: "assistant", content: "published result" },
    ]);
    expect(
      context.conversation
        .getMessages()
        .some((m) => m.content === "streamed UI text"),
    ).toBe(false);

    // MultiAgent's own result mirrors what was published.
    expect(result).toEqual({
      messages: [{ role: "assistant", content: "published result" }],
    });
  });

  it("invokes no child and emits no events for empty input", async () => {
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    expect((await collect(agent, context, "   ")).events).toEqual([]);
    expect(children.general.calls).toHaveLength(0);
    expect(children.research.calls).toHaveLength(0);
    expect(context.conversation.getMessages()).toEqual([]);
  });

  it("settles the published result without anyone consuming events", async () => {
    // The child result is genuinely independent of event drainage, so
    // root publication completes even when the caller only awaits it.
    const children = makeAgents();
    const agent = new MultiAgent(children, new DeterministicPlanner());
    const context = makeContext();

    const run = agent.run("hello", context);
    const result = await run.result;

    expect(result).toEqual({
      messages: [{ role: "assistant", content: "GENERAL" }],
    });
    expect(children.general.calls).toHaveLength(1);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("follows the planner instead of reimplementing routing", async () => {
    // Decisive boundary test: input that would deterministically route to
    // general, but the injected planner says research. If MultiAgent still
    // contained hard-coded routing rules, the wrong child would execute.
    const children = makeAgents();
    const planner = new FixedPlanner(["research"]);
    const agent = new MultiAgent(children, planner);
    const context = makeContext();

    const { events } = await collect(agent, context, "hello");

    expect(planner.calls).toHaveLength(1);
    expect(children.research.calls).toHaveLength(1);
    expect(children.general.calls).toHaveLength(0);
    expect(events[0]).toEqual({ type: "agent_start", agent: "research" });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "RESEARCH" },
    ]);
  });

  it("gives the planner input, snapshot, and exactly the child descriptors", async () => {
    const children = makeAgents();
    const planner = new FixedPlanner(["general"]);
    const agent = new MultiAgent(children, planner);
    const context = makeContext();

    await collect(agent, context, "/research x");

    // The agents MultiAgent can execute are exactly the agents the planner
    // is told about — built from the child collection, not duplicated.
    expect(planner.calls).toEqual([
      {
        input: "/research x",
        messages: [],
        agents: [GENERAL_DESCRIPTOR, RESEARCH_DESCRIPTOR, CODER_DESCRIPTOR],
      },
    ]);
  });

  it("gives the planner previous history without the current user message", async () => {
    const children = makeAgents();
    const planner = new FixedPlanner(["general"]);
    const agent = new MultiAgent(children, planner);
    const context = makeContext();
    context.conversation.add("user", "previous");
    context.conversation.add("assistant", "reply");

    await collect(agent, context, "current");

    // Snapshot precedes root recording: prior history only, current input
    // carried separately — never duplicated inside messages.
    expect(planner.calls).toEqual([
      {
        input: "current",
        messages: [
          { role: "user", content: "previous" },
          { role: "assistant", content: "reply" },
        ],
        agents: [GENERAL_DESCRIPTOR, RESEARCH_DESCRIPTOR, CODER_DESCRIPTOR],
      },
    ]);

    // Normal execution still records the full turn afterwards.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "previous" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "current" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("keeps the canonical conversation unchanged when the planner mutates its snapshot", async () => {
    const mutatingPlanner: Planner = {
      plan(input: PlannerInput): Promise<Plan> {
        // Deliberate cast: simulates a malicious/buggy JS planner bypassing
        // the readonly types. Runtime snapshot copies must still protect
        // canonical state.
        const messages = input.messages as Message[];
        messages.push({ role: "user", content: "injected" });
        messages[0]!.content = "corrupted";
        return Promise.resolve({ agents: ["general"] });
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(children, mutatingPlanner);
    const context = makeContext();
    context.conversation.add("user", "previous");

    await collect(agent, context, "current");

    // The planner only ever saw a snapshot copy: canonical history holds
    // the real turns with no trace of the attempted corruption.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "previous" },
      { role: "user", content: "current" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("executes no agent and touches no state when planning fails", async () => {
    const failingPlanner: Planner = {
      plan(): Promise<Plan> {
        return Promise.reject(new Error("no plan"));
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(children, failingPlanner);
    const context = makeContext();

    const { events, result } = await collect(agent, context, "hello");

    expect(children.general.calls).toHaveLength(0);
    expect(children.research.calls).toHaveLength(0);
    expect(events).toEqual([{ type: "error", error: new Error("no plan") }]);
    expect(result).toEqual({ messages: [] });
    expect(context.conversation.getMessages()).toEqual([]);
  });

  it("keeps agent metadata unchanged when the planner mutates descriptors", async () => {
    const mutatingPlanner: Planner = {
      plan(input: PlannerInput): Promise<Plan> {
        // Deliberate cast: simulates a malicious/buggy JS planner bypassing
        // the readonly types. Fresh per-run descriptor copies must still
        // protect actual agent configuration.
        const agents = input.agents as {
          name: string;
          description: string;
        }[];
        agents.push({ name: "injected", description: "fake" });
        for (const agent of agents) {
          agent.name = "corrupted";
          agent.description = "corrupted";
        }
        return Promise.resolve({ agents: ["general"] });
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(children, mutatingPlanner);
    const context = makeContext();

    const { events } = await collect(agent, context, "hello");

    // Descriptors were fresh per-run copies: the actual agents are intact
    // and execution still carries the real identity.
    expect(children.general.descriptor).toEqual(GENERAL_DESCRIPTOR);
    expect(children.research.descriptor).toEqual(RESEARCH_DESCRIPTOR);
    expect(events[0]).toEqual({ type: "agent_start", agent: "general" });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "GENERAL" },
    ]);
  });

  it("rejects a plan naming an agent it cannot execute", async () => {
    const roguePlanner: Planner = {
      plan(): Promise<Plan> {
        return Promise.resolve({ agents: ["does-not-exist"] });
      },
    };
    const children = makeAgents();
    const agent = new MultiAgent(children, roguePlanner);
    const context = makeContext();

    const { events, result } = await collect(agent, context, "hello");

    expect(children.general.calls).toHaveLength(0);
    expect(children.research.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "error", error: new Error('Unknown agent: "does-not-exist"') },
    ]);
    expect(result).toEqual({ messages: [] });
    // Like any failed turn, the user message is retained with no assistant.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });
});
