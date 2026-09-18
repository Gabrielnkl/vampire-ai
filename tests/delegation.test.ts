import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { MultiAgent } from "../src/agents/multi-agent.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import { freezeDelegationRequest } from "../src/agents/delegation.js";
import type { DelegationRequest } from "../src/agents/delegation.js";
import type { AgentDescriptor } from "../src/agents/descriptor.js";
import type { Message } from "../src/chat/message.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Agent, AgentRun } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { AgentEvent } from "../src/agents/events.js";
import type { AgentResult } from "../src/agents/result.js";

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

function makeContext(): AgentContext {
  return { conversation: new Conversation(), previousResults: [] };
}

/**
 * Fake agent that requests other agents by emitting `delegation_request`
 * events. Settles an empty result like any agent whose work is a request
 * rather than content.
 */
class DelegatingAgent implements Agent {
  calls: { input: string; context: AgentContext }[] = [];
  readonly descriptor = {
    name: "delegator",
    description: "Delegating test agent.",
  };

  constructor(
    private readonly requests: { agent: string; input: string }[] = [],
    private readonly resultId = "delegator-result-1",
  ) {}

  run(input: string, context: AgentContext): AgentRun {
    this.calls.push({ input, context });
    const name = this.descriptor.name;
    const requests = this.requests;
    const resultId = this.resultId;
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "agent_start", agent: name };
      for (const request of requests) {
        yield {
          type: "delegation_request",
          request: freezeDelegationRequest(request.agent, request.input),
        };
      }
      yield { type: "agent_end", agent: name };
    }
    return {
      events: events(),
      result: Promise.resolve({ agent: name, id: resultId, messages: [] }),
    };
  }
}

/** Spy child with deterministic per-run IDs, recording calls and results. */
class SpyAgent implements Agent {
  calls: { input: string; context: AgentContext }[] = [];
  results: AgentResult[] = [];
  private resultCount = 0;

  constructor(
    readonly descriptor: AgentDescriptor,
    private readonly tag: string = "",
  ) {}

  run(input: string, context: AgentContext): AgentRun {
    this.calls.push({ input, context });
    const name = this.descriptor.name;
    const tag = this.tag;
    this.resultCount += 1;
    const result: AgentResult = {
      agent: name,
      id: `${name}-spy-${this.resultCount}`,
      messages: tag === "" ? [] : [{ role: "assistant", content: tag }],
    };
    this.results.push(result);
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: "agent_start", agent: name };
      yield { type: "message_start", role: "assistant" };
      if (tag !== "") {
        yield { type: "text_delta", text: tag };
      }
      yield { type: "message_end" };
      yield { type: "agent_end", agent: name };
    }
    return { events: events(), result: Promise.resolve(result) };
  }
}

function scriptedLLM(chunks: string[] = []): LLMClient {
  return {
    async *stream(_messages: Message[]): AsyncGenerator<string> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    async complete(): Promise<string> {
      return Promise.reject(new Error("unused"));
    },
  };
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

describe("delegation boundary", () => {
  it("preserves request shape through the freeze boundary", async () => {
    const request: DelegationRequest = freezeDelegationRequest(
      "coder",
      "analyze this function",
    );

    expect(request).toEqual({ agent: "coder", input: "analyze this function" });
  });

  it("freezes requests against adversarial mutation", async () => {
    const attempts: string[] = [];
    const agent = new MultiAgent(
      {
        delegator: new DelegatingAgent([
          { agent: "coder", input: "analyze this function" },
        ]),
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["delegator"] }) },
    );

    const { events } = await collect(agent, makeContext(), "go");

    const received = events.find((e) => e.type === "delegation_request");
    expect(received).toBeDefined();
    if (received?.type !== "delegation_request") {
      throw new Error("unreachable");
    }
    // Deliberate casts: simulate a malicious consumer bypassing the
    // readonly types. The frozen request must survive unchanged.
    const mutable = received.request as unknown as {
      agent: string;
      input: string;
    };
    try {
      mutable.agent = "research";
      attempts.push("agent");
    } catch {
      attempts.push("agent-threw");
    }
    try {
      mutable.input = "attacker";
      attempts.push("input");
    } catch {
      attempts.push("input-threw");
    }

    expect(attempts).toHaveLength(2);
    expect(received.request).toEqual({
      agent: "coder",
      input: "analyze this function",
    });
  });
});

describe("delegation execution", () => {
  it("executes a real SingleAgent delegation request exactly once", async () => {
    const research = new SpyAgent(RESEARCH_DESCRIPTOR, "ROUTED");
    const agent = new MultiAgent(
      {
        general: new SingleAgent(
          scriptedLLM(["ok"]),
          GENERAL_DESCRIPTOR,
          [{ agent: "research", input: "investigate this topic" }],
        ),
        research,
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["general"] }) },
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "hello");

    // Research ran exactly once, with the request input…
    expect(research.calls).toHaveLength(1);
    expect(research.calls[0]?.input).toBe("investigate this topic");
    // …in an isolated context forked from the root (never the
    // requester's mutable conversation)…
    expect(research.calls[0]?.context.conversation).not.toBe(
      context.conversation,
    );
    expect(
      research.calls[0]?.context.conversation.getMessages(),
    ).toEqual([{ role: "user", content: "hello" }]);
    // …settled its own result, published through the outer execution.
    expect(research.results).toHaveLength(1);
    // Delegated work publishes inline, before the requesting agent's own
    // result settles — publication follows event order.
    expect(result.messages).toEqual([
      { role: "assistant", content: "ROUTED" },
      { role: "assistant", content: "ok" },
    ]);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "ROUTED" },
      { role: "assistant", content: "ok" },
    ]);
    // Delegated lifecycle is fully observable in the outer stream, inline
    // at the interception point: the delegated bracket nests inside the
    // requesting execution, before its own message events.
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "delegation_request",
      "agent_start",
      "message_start",
      "text_delta",
      "message_end",
      "agent_end",
      "message_start",
      "text_delta",
      "message_end",
      "agent_end",
    ]);
  });

  it("keeps the delegated result's provenance intact", async () => {
    const research = new SpyAgent(RESEARCH_DESCRIPTOR, "ROUTED");
    const agent = new MultiAgent(
      {
        general: new DelegatingAgent([
          { agent: "research", input: "investigate" },
        ]),
        research,
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["general"] }) },
    );
    const context = makeContext();

    const { result } = await collect(agent, context, "hello");

    // The delegated result is used exactly as settled — agent, id and
    // messages untouched by the outer agent.
    expect(research.results).toHaveLength(1);
    expect(result.messages).toEqual([
      { role: "assistant", content: "ROUTED" },
    ]);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "ROUTED" },
    ]);
    const delegated = research.results[0] as AgentResult;
    expect(delegated.agent).toBe("research");
    expect(delegated.id).toBe("research-spy-1");
  });

  it("rejects an unknown delegation target without executing", async () => {
    const research = new SpyAgent(RESEARCH_DESCRIPTOR);
    const agent = new MultiAgent(
      {
        general: new DelegatingAgent([
          { agent: "unknown", input: "do it" },
        ]),
        research,
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["general"] }) },
    );
    const context = makeContext();

    const { events, result } = await collect(agent, context, "hello");

    expect(research.calls).toHaveLength(0);
    expect(events).toContainEqual({
      type: "error",
      error: new Error('Unknown agent: "unknown"'),
    });
    expect(result).toEqual({
      id: expect.any(String),
      agent: "multi",
      messages: [],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("gives the delegated child the completed results, never unfinished output", async () => {
    const general = new SpyAgent(GENERAL_DESCRIPTOR, "A-OUTPUT");
    const research = new SpyAgent(RESEARCH_DESCRIPTOR);
    const agent = new MultiAgent(
      {
        general,
        delegator: new DelegatingAgent([
          { agent: "research", input: "investigate" },
        ]),
        research,
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["general", "delegator"] }) },
    );
    const context = makeContext();

    await collect(agent, context, "chain");

    expect(research.calls).toHaveLength(1);
    expect(research.calls[0]?.context.previousResults).toEqual([
      {
        agent: "general",
        id: "general-spy-1",
        messages: [{ role: "assistant", content: "A-OUTPUT" }],
      },
    ]);
  });

  it("exposes the delegated result to the next execution context", async () => {
    const seen: AgentResult[][] = [];
    const recording: Agent = {
      descriptor: CODER_DESCRIPTOR,
      run(_input: string, childContext: AgentContext): AgentRun {
        seen.push([...childContext.previousResults]);
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "coder" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "coder" };
        }
        return {
          events: events(),
          result: Promise.resolve({
            agent: "coder",
            id: "coder-recording-1",
            messages: [],
          }),
        };
      },
    };
    const research = new SpyAgent(RESEARCH_DESCRIPTOR, "ROUTED");
    const agent = new MultiAgent(
      {
        general: new DelegatingAgent([
          { agent: "research", input: "investigate" },
        ]),
        research,
        coder: recording,
      },
      { plan: async () => ({ agents: ["general", "coder"] }) },
    );
    const context = makeContext();

    await collect(agent, context, "chain");

    // Delegation runs inline during general's execution, so the delegated
    // result settles (and publishes) before general's own result.
    expect(seen).toEqual([
      [
        { agent: "research", id: "research-spy-1", messages: [{ role: "assistant", content: "ROUTED" }] },
        { agent: "delegator", id: "delegator-result-1", messages: [] },
      ],
    ]);
  });

  it("never executes a nested delegation request", async () => {
    const coder = new SpyAgent(CODER_DESCRIPTOR);
    const agent = new MultiAgent(
      {
        general: new DelegatingAgent([
          { agent: "research", input: "investigate" },
        ]),
        research: new DelegatingAgent(
          [{ agent: "coder", input: "nested" }],
          "research-delegating-1",
        ),
        coder,
      },
      { plan: async () => ({ agents: ["general"] }) },
    );

    const { events } = await collect(agent, makeContext(), "go");

    // Both requests stay observable…
    const requests = events.filter((e) => e.type === "delegation_request");
    expect(requests).toEqual([
      {
        type: "delegation_request",
        request: { agent: "research", input: "investigate" },
      },
      {
        type: "delegation_request",
        request: { agent: "coder", input: "nested" },
      },
    ]);
    // …but the nested target never executes.
    expect(coder.calls).toHaveLength(0);
  });

  it("executes only the first of several delegation requests", async () => {
    const research = new SpyAgent(RESEARCH_DESCRIPTOR);
    const coder = new SpyAgent(CODER_DESCRIPTOR);
    const agent = new MultiAgent(
      {
        general: new DelegatingAgent([
          { agent: "research", input: "first" },
          { agent: "coder", input: "second" },
        ]),
        research,
        coder,
      },
      { plan: async () => ({ agents: ["general"] }) },
    );

    const { events } = await collect(agent, makeContext(), "go");

    expect(research.calls).toHaveLength(1);
    expect(research.calls[0]?.input).toBe("first");
    expect(coder.calls).toHaveLength(0);
    // Both requests remain observable; the rejected extra surfaces as an
    // error rather than a second execution.
    expect(events.filter((e) => e.type === "delegation_request")).toHaveLength(2);
    expect(events).toContainEqual({
      type: "error",
      error: new Error("Only one delegation per execution is supported"),
    });
  });

  it("keeps a delegated child isolated from the requester", async () => {
    const mutating: Agent = {
      descriptor: RESEARCH_DESCRIPTOR,
      run(_input: string, childContext: AgentContext): AgentRun {
        childContext.conversation.add("assistant", "child-only note");
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "agent_start", agent: "research" };
          yield { type: "message_start", role: "assistant" };
          yield { type: "message_end" };
          yield { type: "agent_end", agent: "research" };
        }
        return {
          events: events(),
          result: Promise.resolve({
            agent: "research",
            id: "research-mutating-1",
            messages: [],
          }),
        };
      },
    };
    const agent = new MultiAgent(
      {
        general: new DelegatingAgent([
          { agent: "research", input: "investigate" },
        ]),
        research: mutating,
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["general"] }) },
    );
    const context = makeContext();

    await collect(agent, context, "hello");

    // The private note never reaches the root, which records only the
    // user-visible turn (delegated empty result publishes nothing).
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });
});

describe("delegation continuation limit", () => {
  function recordingLLM(chunks: string[]) {
    const received: Message[][] = [];
    const llm: LLMClient = {
      async *stream(messages: Message[]): AsyncGenerator<string> {
        received.push(messages.map((m) => ({ ...m })));
        for (const chunk of chunks) {
          yield chunk;
        }
      },
      async complete(): Promise<string> {
        return Promise.reject(new Error("unused"));
      },
    };
    return { llm, received };
  }

  it("does not feed the delegated result back into the requesting agent", async () => {
    // Baseline characterization: a requesting SingleAgent runs its full
    // linear execution (including its final LLM call) from run-start
    // state. MultiAgent can observe the delegation_request and execute
    // the child, but has no channel to resume the requester with the
    // settled result — so the requester's LLM input provably excludes it.
    // See the continuation analysis: resuming would require AgentRun to
    // become suspendable (coroutine), or splitting one logical execution
    // into two runs (duplicated lifecycle + history).
    const general = recordingLLM(["GENERAL RESULT"]);
    const research = recordingLLM(["RESEARCH RESULT"]);
    const agent = new MultiAgent(
      {
        general: new SingleAgent(
          general.llm,
          GENERAL_DESCRIPTOR,
          [{ agent: "research", input: "investigate" }],
        ),
        research: new SingleAgent(research.llm, RESEARCH_DESCRIPTOR),
        coder: new SpyAgent(CODER_DESCRIPTOR),
      },
      { plan: async () => ({ agents: ["general"] }) },
    );
    const context = makeContext();

    const { result } = await collect(agent, context, "go");

    // Research executed exactly once, with the request input appended to
    // its isolated fork (which already holds the recorded user turn)…
    expect(research.received).toEqual([
      [
        { role: "user", content: "go" },
        { role: "user", content: "investigate" },
      ],
    ]);
    // …but general's own LLM input contains no trace of it: no system
    // context block, only its own conversation.
    expect(general.received).toEqual([[{ role: "user", content: "go" }]]);
    // Root publication follows event order; both outputs stay independent.
    expect(result.messages).toEqual([
      { role: "assistant", content: "RESEARCH RESULT" },
      { role: "assistant", content: "GENERAL RESULT" },
    ]);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "RESEARCH RESULT" },
      { role: "assistant", content: "GENERAL RESULT" },
    ]);
  });
});
