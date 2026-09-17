import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversation.js";

describe("Conversation", () => {
  it("starts empty without a system prompt", () => {
    const convo = new Conversation();
    expect(convo.getMessages()).toEqual([]);
  });

  it("includes the system prompt as the first message", () => {
    const convo = new Conversation("Be helpful.");
    expect(convo.getMessages()).toEqual([
      { role: "system", content: "Be helpful." },
    ]);
  });

  it("adds user and assistant messages in order", () => {
    const convo = new Conversation("System.");
    convo.add("user", "Hello");
    convo.add("assistant", "Hi there");
    expect(convo.getMessages()).toEqual([
      { role: "system", content: "System." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("returned messages cannot mutate internal state", () => {
    const convo = new Conversation();
    convo.add("user", "Hello");

    const messages = convo.getMessages();
    messages.push({ role: "user", content: "Hacked" });
    messages[0]!.content = "Mutated";

    expect(convo.getMessages()).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  it("clone carries the messages without sharing mutable state", () => {
    const convo = new Conversation("System.");
    convo.add("user", "Hello");

    const copy = convo.clone();

    expect(copy).not.toBe(convo);
    expect(copy.getMessages()).toEqual(convo.getMessages());

    copy.add("assistant", "child-only");
    convo.add("assistant", "parent-only");

    expect(copy.getMessages()).toEqual([
      { role: "system", content: "System." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "child-only" },
    ]);
    expect(convo.getMessages()).toEqual([
      { role: "system", content: "System." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "parent-only" },
    ]);
  });
});
