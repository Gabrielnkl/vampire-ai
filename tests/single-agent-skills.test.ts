import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { Message } from "../src/chat/message.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Skill } from "../src/skills/skill.js";

class FakeLLM implements LLMClient {
  received: Message[][] = [];
  constructor(private readonly chunks: string[] = ["ok"]) {}

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

const SKILL: Skill = Object.freeze({
  name: "code-review",
  description: "Review code. Use when asked to review code.",
  instructions: "# Code Review\n\nSteps.",
  sourcePath: "skills/code-review/SKILL.md",
});

const descriptor = { name: "coder", description: "Writes and explains code." };

async function run(agent: SingleAgent, context: AgentContext, input: string): Promise<void> {
  const run = agent.run(input, context);
  for await (const _ of run.events) {
    // drain
  }
  await run.result;
}

describe("SingleAgent skills", () => {
  it("sends the unchanged request when no skills are bound", async () => {
    const llm = new FakeLLM();
    const agent = new SingleAgent(llm, descriptor);
    await run(agent, { conversation: new Conversation(), previousResults: [] }, "Hi");
    expect(llm.received).toEqual([[{ role: "user", content: "Hi" }]]);
  });

  it("appends bound skills as trailing system messages", async () => {
    const llm = new FakeLLM();
    const agent = new SingleAgent(llm, descriptor, [], [SKILL]);
    await run(agent, { conversation: new Conversation(), previousResults: [] }, "Hi");
    expect(llm.received).toEqual([
      [
        { role: "user", content: "Hi" },
        {
          role: "system",
          content: 'Skill "code-review": Review code. Use when asked to review code.\n# Code Review\n\nSteps.',
        },
      ],
    ]);
  });

  it("keeps skill messages out of the canonical conversation", async () => {
    const llm = new FakeLLM();
    const agent = new SingleAgent(llm, descriptor, [], [SKILL]);
    const context: AgentContext = { conversation: new Conversation(), previousResults: [] };
    await run(agent, context, "Hi");
    expect(context.conversation.getMessages()).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("seals skills at construction so later mutation cannot change behavior", async () => {
    const llm = new FakeLLM();
    const mutable: Skill[] = [{ ...SKILL }];
    const agent = new SingleAgent(llm, descriptor, [], mutable);
    mutable.length = 0;
    await run(agent, { conversation: new Conversation(), previousResults: [] }, "Hi");
    expect(llm.received).toHaveLength(1);
    expect(llm.received[0]).toHaveLength(2);
  });
});
