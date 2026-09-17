import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";
import { forkContext } from "../src/agents/context.js";
import type { AgentContext } from "../src/agents/context.js";

function makeParent(): AgentContext {
  const conversation = new Conversation("System.");
  conversation.add("user", "before");
  conversation.add("assistant", "after");
  return { conversation, previousResults: [] };
}

describe("forkContext", () => {
  it("derives distinct context and conversation objects", () => {
    const parent = makeParent();
    const child = forkContext(parent);

    expect(child).not.toBe(parent);
    expect(child.conversation).not.toBe(parent.conversation);
  });

  it("preloads the child with the parent's current messages", () => {
    const parent = makeParent();

    expect(forkContext(parent).conversation.getMessages()).toEqual(
      parent.conversation.getMessages(),
    );
  });

  it("isolates child mutations from the parent", () => {
    const parent = makeParent();
    const child = forkContext(parent);

    child.conversation.add("user", "child-only");

    expect(parent.conversation.getMessages()).toEqual([
      { role: "system", content: "System." },
      { role: "user", content: "before" },
      { role: "assistant", content: "after" },
    ]);
  });

  it("isolates parent mutations from the child", () => {
    const parent = makeParent();
    const child = forkContext(parent);

    parent.conversation.add("user", "parent-only");

    expect(child.conversation.getMessages()).toEqual([
      { role: "system", content: "System." },
      { role: "user", content: "before" },
      { role: "assistant", content: "after" },
    ]);
  });
});
