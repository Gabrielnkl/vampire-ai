import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { AgentEvent } from "../src/agents/events.js";
import type { Message } from "../src/chat/message.js";
import type { LLMClient, LLMStep, ToolSpec } from "../src/llm/client.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";

/** Scripted function-calling fake: returns queued steps in order. */
class ScriptedLLM implements LLMClient {
  received: { messages: Message[]; tools: ToolSpec[] }[] = [];
  streamed = 0;
  constructor(private readonly steps: LLMStep[]) {}

  async *stream(_messages: Message[]): AsyncGenerator<string> {
    this.streamed++;
    yield "legacy";
  }

  complete(_messages: Message[]): Promise<string> {
    return Promise.resolve("legacy");
  }

  async streamStep(messages: Message[], tools: ToolSpec[]): Promise<LLMStep> {
    this.received.push({ messages: messages.map((m) => ({ ...m })), tools });
    const step = this.steps[Math.min(this.received.length - 1, this.steps.length - 1)];
    if (step === undefined) {
      throw new Error("ScriptedLLM ran out of steps.");
    }
    return step;
  }
}

const descriptor = { name: "coder", description: "Writes code." };

async function collect(
  agent: SingleAgent,
  context: AgentContext,
  input: string,
): Promise<AgentEvent[]> {
  const run = agent.run(input, context);
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  await run.result;
  return events;
}

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "vampire-agent-tools-"));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("SingleAgent tool loop", () => {
  it("falls back to legacy stream() when no tools are bound", async () => {
    const llm = new ScriptedLLM([{ text: "unused", toolCalls: [] }]);
    const agent = new SingleAgent(llm, descriptor);
    const context: AgentContext = { conversation: new Conversation(), previousResults: [] };
    const run = agent.run("Hi", context);
    const events: AgentEvent[] = [];
    for await (const e of run.events) {
      events.push(e);
    }
    const result = await run.result;
    expect(llm.streamed).toBe(1);
    expect(llm.received).toHaveLength(0);
    expect(result.messages).toEqual([{ role: "assistant", content: "legacy" }]);
    expect(events.some((e) => e.type === "tool_start")).toBe(false);
  });

  it("executes a read then answers, keeping tools out of the conversation", async () => {
    const dir = makeDir({ "a.txt": "file-contents" });
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
      { text: "saw it", toolCalls: [] },
    ]);
    const agent = new SingleAgent(llm, descriptor, [], [], [readFileTool], {
      cwd: dir,
      logPath: "",
    });
    const context: AgentContext = { conversation: new Conversation(), previousResults: [] };
    const events = await collect(agent, context, "read a");

    expect(events).toEqual([
      { type: "agent_start", agent: "coder" },
      { type: "message_start", role: "assistant" },
      { type: "tool_start", name: "read_file", args: '{"path":"a.txt"}' },
      { type: "tool_end", name: "read_file", ok: true, preview: "file-contents" },
      { type: "text_delta", text: "saw it" },
      { type: "message_end" },
      { type: "agent_end", agent: "coder" },
    ]);
    // Canonical history holds user + final answer only.
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "read a" },
      { role: "assistant", content: "saw it" },
    ]);
    // Second step saw the tool result in its working transcript.
    const second = llm.received[1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(second).toContain("file-contents");
    // Only bound tools are surfaced to the model.
    expect(llm.received[0]?.tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("turns tool failures into recoverable result strings", async () => {
    const dir = makeDir({});
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"missing.txt"}' }],
      },
      { text: "recovered", toolCalls: [] },
    ]);
    const agent = new SingleAgent(llm, descriptor, [], [], [readFileTool], {
      cwd: dir,
      logPath: "",
    });
    const context: AgentContext = { conversation: new Conversation(), previousResults: [] };
    const events = await collect(agent, context, "read missing");

    const end = events.find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ type: "tool_end", name: "read_file", ok: false });
    expect(events.some((e) => e.type === "error")).toBe(false);
    const second = llm.received[1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(second).toContain("Error:");
  });

  it("rejects unknown tools without executing anything", async () => {
    const dir = makeDir({});
    const llm = new ScriptedLLM([
      { text: "", toolCalls: [{ id: "1", name: "nope", arguments: "{}" }] },
      { text: "done", toolCalls: [] },
    ]);
    const agent = new SingleAgent(llm, descriptor, [], [], [readFileTool], {
      cwd: dir,
      logPath: "",
    });
    const events = await collect(
      agent,
      { conversation: new Conversation(), previousResults: [] },
      "hi",
    );
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: false });
  });

  it("caps runaway loops as failures with no published message", async () => {
    const dir = makeDir({ "a.txt": "x" });
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
    ]);
    const agent = new SingleAgent(llm, descriptor, [], [], [readFileTool], {
      cwd: dir,
      maxSteps: 1,
      logPath: "",
    });
    const context: AgentContext = { conversation: new Conversation(), previousResults: [] };
    const run = agent.run("hi", context);
    const events: AgentEvent[] = [];
    for await (const e of run.events) {
      events.push(e);
    }
    const result = await run.result;
    expect(events.some((e) => e.type === "tool_start")).toBe(false);
    expect(events.find((e) => e.type === "error")).toMatchObject({ type: "error" });
    // Failure contract: no message_end, empty result, user message retained.
    expect(events.some((e) => e.type === "message_end")).toBe(false);
    expect(result.messages).toEqual([]);
    expect(context.conversation.getMessages()).toEqual([{ role: "user", content: "hi" }]);
  });

  it("caps excessive calls in a single step", async () => {
    const dir = makeDir({ "a.txt": "x" });
    const calls = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      name: "read_file",
      arguments: '{"path":"a.txt"}',
    }));
    const llm = new ScriptedLLM([{ text: "", toolCalls: calls }]);
    const agent = new SingleAgent(llm, descriptor, [], [], [readFileTool], {
      cwd: dir,
      logPath: "",
    });
    const run = agent.run("hi", { conversation: new Conversation(), previousResults: [] });
    const events: AgentEvent[] = [];
    for await (const e of run.events) {
      events.push(e);
    }
    const result = await run.result;
    expect(events.find((e) => e.type === "error")).toMatchObject({ type: "error" });
    expect(result.messages).toEqual([]);
  });

  it("marks file content starting with 'Error:' as ok", async () => {
    const dir = makeDir({ "log.txt": "Error: timeout at line 1" });
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"log.txt"}' }],
      },
      { text: "done", toolCalls: [] },
    ]);
    const agent = new SingleAgent(llm, descriptor, [], [], [readFileTool], {
      cwd: dir,
      logPath: "",
    });
    const events = await collect(
      agent,
      { conversation: new Conversation(), previousResults: [] },
      "read log",
    );
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({
      type: "tool_end",
      ok: true,
    });
  });

  it("writes through to the filesystem while publishing only text", async () => {
    const dir = makeDir({ "a.txt": "old" });
    const llm = new ScriptedLLM([
      {
        text: "",
        toolCalls: [
          { id: "1", name: "write_file", arguments: '{"path":"a.txt","content":"new"}' },
        ],
      },
      { text: "wrote it", toolCalls: [] },
    ]);
    const agent = new SingleAgent(llm, descriptor, [], [], [writeFileTool], {
      cwd: dir,
      logPath: "",
    });
    const context: AgentContext = { conversation: new Conversation(), previousResults: [] };
    await collect(agent, context, "overwrite a");
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "overwrite a" },
      { role: "assistant", content: "wrote it" },
    ]);
  });
});
