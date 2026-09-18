import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { Agent } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { Message } from "../src/chat/message.js";
import type { LLMClient } from "../src/llm/client.js";
import type { AgentEvent } from "../src/agents/events.js";
import type { AgentResult } from "../src/agents/result.js";
import { freezeResult } from "../src/agents/result.js";

class FakeLLM implements LLMClient {
  received: Message[][] = [];
  constructor(private readonly chunks: string[]) {}

  async *stream(messages: Message[]): AsyncGenerator<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  complete(messages: Message[]): Promise<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    return Promise.resolve(this.chunks.join(""));
  }
}

class FailingLLM implements LLMClient {
  async *stream(_messages: Message[]): AsyncGenerator<string> {
    yield "partial-";
    throw new Error("boom");
  }

  complete(_messages: Message[]): Promise<string> {
    return Promise.reject(new Error("boom"));
  }
}

function makeContext(): AgentContext {
  return { conversation: new Conversation(), previousResults: [] };
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

describe("SingleAgent events", () => {
  it("brackets one execution with agent_start/agent_end around the message events", async () => {
    const context = makeContext();
    const llm = new FakeLLM(["Hello", " world", "!"]);
    const agent = new SingleAgent(llm, { name: "general", description: "General test agent." });

    const { events, result } = await collect(agent, context, "Hi");

    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "text_delta", text: "!" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);

    // Deltas preserve exact order and contents.
    expect(
      events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text),
    ).toEqual(["Hello", " world", "!"]);

    // LLM received the conversation including the new user message.
    expect(llm.received).toHaveLength(1);
    expect(llm.received[0]).toEqual([{ role: "user", content: "Hi" }]);

    // Final assistant message contains the concatenated text.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello world!" },
    ]);

    // Result publishes the accumulated assistant message.
    expect(result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "Hello world!" }],
    });
  });

  it("exposes its stable identity through name and agent_start", async () => {
    const agent = new SingleAgent(new FakeLLM(["ok"]), { name: "research", description: "Research test agent." });
    expect(agent.descriptor).toEqual({ name: "research", description: "Research test agent." });

    const { events } = await collect(agent, makeContext(), "Hi");

    expect(events[0]).toEqual({ type: "agent_start", agent: "research" });
    expect(events.at(-1)).toEqual({ type: "agent_end", agent: "research" });
  });

  it("satisfies the Agent contract through the interface type", async () => {
    const agent: Agent = new SingleAgent(new FakeLLM(["ok"]), { name: "general", description: "General test agent." });

    const { events, result } = await collect(agent, makeContext(), "Hi");

    expect(events[0]).toEqual({ type: "agent_start", agent: "general" });
    expect(events.at(-1)).toEqual({ type: "agent_end", agent: "general" });
    expect(result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "ok" }],
    });
  });

  it("reuses the same context conversation across multiple turns", async () => {
    const received: Message[][] = [];
    const scriptedLLM: LLMClient = {
      async *stream(messages: Message[]): AsyncGenerator<string> {
        received.push(messages.map((m) => ({ ...m })));
        yield received.length === 1 ? "first!" : "second!";
      },
      complete(): Promise<string> {
        return Promise.reject(new Error("complete() is not used by this test"));
      },
    };
    const agent = new SingleAgent(scriptedLLM, { name: "general", description: "General test agent." });
    const context = makeContext();

    const first = await collect(agent, context, "one");
    const second = await collect(agent, context, "two");

    // Second turn's LLM call sees the full history of both turns.
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first!" },
      { role: "user", content: "two" },
    ]);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first!" },
      { role: "user", content: "two" },
      { role: "assistant", content: "second!" },
    ]);
    expect(first.result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "first!" }],
    });
    expect(second.result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "second!" }],
    });
  });

  it("ends the execution bracket on failure without message_end or a stored response", async () => {
    const context = makeContext();
    const agent = new SingleAgent(new FailingLLM(), { name: "general", description: "General test agent." });

    const { events, result } = await collect(agent, context, "Hi");

    // agent_end closes the bracket even though the run failed: it means
    // "execution ended", not "execution succeeded" (no message_end).
    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({ type: "agent_start", agent: "general" });
    expect(events[1]).toEqual({ type: "message_start", role: "assistant" });
    expect(events[2]).toEqual({ type: "text_delta", text: "partial-" });
    expect(events[3]?.type).toBe("error");
    expect((events[3] as { error: Error }).error.message).toBe("boom");
    expect(events[4]).toEqual({ type: "agent_end", agent: "general" });
    expect(events.some((e) => e.type === "message_end")).toBe(false);

    // User message retained, but no assistant message stored.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
    ]);

    // Partial streamed output is not a published result.
    expect(result).toEqual({ agent: "general", id: expect.any(String), messages: [] });
  });

  it("emits the full lifecycle with no deltas and stores nothing for an empty response", async () => {
    const context = makeContext();
    const agent = new SingleAgent(new FakeLLM([]), { name: "general", description: "General test agent." });

    const { events, result } = await collect(agent, context, "Hi");

    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
    ]);
    expect(result).toEqual({ agent: "general", id: expect.any(String), messages: [] });
  });

  it("treats empty user input as a no-op with no events", async () => {
    const context = makeContext();
    const llm = new FakeLLM(["should never be used"]);
    const agent = new SingleAgent(llm, { name: "general", description: "General test agent." });

    const { events, result } = await collect(agent, context, "   ");

    expect(events).toEqual([]);
    expect(result).toEqual({ agent: "general", id: expect.any(String), messages: [] });
    expect(llm.received).toHaveLength(0);
    expect(context.conversation.getMessages()).toEqual([]);
  });

  it("keeps independent AgentContext instances isolated", async () => {
    // One stateless agent serving two independent contexts.
    const agent = new SingleAgent(new FakeLLM(["reply"]), { name: "general", description: "General test agent." });
    const first = makeContext();
    const second = makeContext();

    await collect(agent, first, "hello");

    expect(first.conversation.getMessages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ]);
    expect(second.conversation.getMessages()).toEqual([]);
  });

  it("settles the result without anyone consuming events", async () => {
    // Regression guard for the old drain-coupled contract: awaiting
    // `result` alone must complete. Would hang (test timeout) if the
    // result still required event-stream drainage.
    const context = makeContext();
    const llm = new FakeLLM(["Hello", " world"]);
    const agent = new SingleAgent(llm, { name: "general", description: "General test agent." });

    const run = agent.run("Hi", context);
    const result = await run.result;

    expect(result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "Hello world" }],
    });
    expect(llm.received).toHaveLength(1);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello world" },
    ]);
  });

  it("shares a single execution between concurrent events and result consumers", async () => {
    const context = makeContext();
    const llm = new FakeLLM(["Hel", "lo"]);
    const agent = new SingleAgent(llm, { name: "general", description: "General test agent." });

    const run = agent.run("Hi", context);
    const drain = (async (): Promise<AgentEvent[]> => {
      const events: AgentEvent[] = [];
      for await (const event of run.events) {
        events.push(event);
      }
      return events;
    })();
    const [events, result] = await Promise.all([drain, run.result]);

    // Exactly one underlying LLM execution for both outputs.
    expect(llm.received).toHaveLength(1);
    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
    expect(result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "Hello" }],
    });
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("replays buffered events to a consumer that drains after awaiting the result", async () => {
    const context = makeContext();
    const agent = new SingleAgent(new FakeLLM(["late"]), { name: "general", description: "General test agent." });

    const run = agent.run("Hi", context);
    const result = await run.result;

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
    }

    expect(result).toEqual({
      agent: "general",
      id: expect.any(String),
      messages: [{ role: "assistant", content: "late" }],
    });
    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "late" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
  });
});

describe("SingleAgent result identity", () => {
  const descriptor = { name: "general", description: "General test agent." };

  it("mints a distinct id per run of the same agent", async () => {
    const agent = new SingleAgent(new FakeLLM(["ok"]), descriptor);

    const first = await collect(agent, makeContext(), "one");
    const second = await collect(agent, makeContext(), "two");

    expect(first.result.agent).toBe("general");
    expect(second.result.agent).toBe("general");
    expect(typeof first.result.id).toBe("string");
    expect(first.result.id.length).toBeGreaterThan(0);
    expect(second.result.id.length).toBeGreaterThan(0);
    expect(first.result.id).not.toBe(second.result.id);
  });

  it("mints distinct ids for empty results", async () => {
    const agent = new SingleAgent(new FakeLLM([]), descriptor);

    const first = await collect(agent, makeContext(), "one");
    const second = await collect(agent, makeContext(), "two");

    expect(first.result).toEqual({ agent: "general", id: expect.any(String), messages: [] });
    expect(first.result.id.length).toBeGreaterThan(0);
    expect(first.result.id).not.toBe(second.result.id);
  });

  it("mints distinct ids for failed results without changing failure semantics", async () => {
    const agent = new SingleAgent(new FailingLLM(), descriptor);

    const first = await collect(agent, makeContext(), "one");
    const second = await collect(agent, makeContext(), "two");

    for (const run of [first, second]) {
      expect(run.result).toEqual({ agent: "general", id: expect.any(String), messages: [] });
      expect(run.events.some((e) => e.type === "message_end")).toBe(false);
    }
    expect(first.result.id).not.toBe(second.result.id);
  });
});

describe("SingleAgent previousResults", () => {
  const descriptor = { name: "general", description: "General test agent." };

  it("sends the unchanged request when there are no previous results", async () => {
    const context = makeContext();
    const llm = new FakeLLM(["ok"]);
    const agent = new SingleAgent(llm, descriptor);

    await collect(agent, context, "Hi");

    expect(llm.received).toEqual([[{ role: "user", content: "Hi" }]]);
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("appends one previous result as explicit execution context", async () => {
    const context: AgentContext = {
      conversation: new Conversation(),
      previousResults: [
        freezeResult("prev-1", "general", [{ role: "assistant", content: "prior answer" }]),
      ],
    };
    const llm = new FakeLLM(["ok"]);
    const agent = new SingleAgent(llm, descriptor);

    await collect(agent, context, "Hi");

    expect(llm.received).toEqual([
      [
        { role: "user", content: "Hi" },
        {
          role: "system",
          content:
            "Previous agent results (runtime execution context, not conversation history):\n" +
            "[Result 1 \u2014 general]\nprior answer",
        },
      ],
    ]);
    // The context message is request-only: canonical history is untouched.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("preserves the order of multiple previous results", async () => {
    const context: AgentContext = {
      conversation: new Conversation(),
      previousResults: [
        freezeResult("prev-1", "general", [{ role: "assistant", content: "first" }]),
        freezeResult("prev-2", "general", [{ role: "assistant", content: "second" }]),
        freezeResult("prev-3", "general", [{ role: "assistant", content: "third" }]),
      ],
    };
    const llm = new FakeLLM(["ok"]);
    const agent = new SingleAgent(llm, descriptor);

    await collect(agent, context, "Hi");

    expect(llm.received).toHaveLength(1);
    expect(llm.received[0]?.at(-1)).toEqual({
      role: "system",
      content:
        "Previous agent results (runtime execution context, not conversation history):\n" +
        "[Result 1 \u2014 general]\nfirst\n\n[Result 2 \u2014 general]\nsecond\n\n[Result 3 \u2014 general]\nthird",
    });
  });

  it("reads previousResults without mutating them", async () => {
    const previous = freezeResult("prev-1", "general", [{ role: "assistant", content: "prior" }]);
    const context: AgentContext = {
      conversation: new Conversation(),
      previousResults: [previous],
    };
    const agent = new SingleAgent(new FakeLLM(["ok"]), descriptor);

    await collect(agent, context, "Hi");

    expect(context.previousResults).toEqual([
      {
        agent: "general",
        id: "prev-1",
        messages: [{ role: "assistant", content: "prior" }],
      },
    ]);
  });
});

describe("SingleAgent delegation requests", () => {
  const descriptor = { name: "general", description: "General test agent." };

  function delegatingAgent(chunks: string[]) {
    return new SingleAgent(new FakeLLM(chunks), descriptor, [
      { agent: "research", input: "investigate this topic" },
    ]);
  }

  it("emits the configured request with exact agent and input", async () => {
    const { events } = await collect(delegatingAgent([]), makeContext(), "Hi");

    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      {
        type: "delegation_request",
        request: { agent: "research", input: "investigate this topic" },
      },
      { type: "message_start", role: "assistant" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
  });

  it("keeps the request out of the result and the conversation", async () => {
    const context = makeContext();

    const { result } = await collect(delegatingAgent([]), context, "Hi");

    expect(result.messages).toEqual([]);
    expect(result.agent).toBe("general");
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  it("keeps ordinary assistant prose as text deltas, not requests", async () => {
    const agent = new SingleAgent(
      new FakeLLM(["please delegate to research"]),
      descriptor,
    );

    const { events } = await collect(agent, makeContext(), "Hi");

    expect(events).toEqual([
      { type: "agent_start", agent: "general" },
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "please delegate to research" },
      { type: "message_end" },
      { type: "agent_end", agent: "general" },
    ]);
    expect(events.some((e) => e.type === "delegation_request")).toBe(false);
  });
});
