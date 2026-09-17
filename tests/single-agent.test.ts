import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { Agent } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { Message } from "../src/chat/message.js";
import type { LLMClient } from "../src/llm/client.js";
import type { AgentEvent } from "../src/agents/events.js";
import type { AgentResult } from "../src/agents/result.js";

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
      messages: [{ role: "assistant", content: "first!" }],
    });
    expect(second.result).toEqual({
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
    expect(result).toEqual({ messages: [] });
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
    expect(result).toEqual({ messages: [] });
  });

  it("treats empty user input as a no-op with no events", async () => {
    const context = makeContext();
    const llm = new FakeLLM(["should never be used"]);
    const agent = new SingleAgent(llm, { name: "general", description: "General test agent." });

    const { events, result } = await collect(agent, context, "   ");

    expect(events).toEqual([]);
    expect(result).toEqual({ messages: [] });
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
