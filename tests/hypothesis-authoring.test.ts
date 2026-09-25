import { describe, expect, it } from "vitest";
import {
  authorHypothesis,
  parseHypothesisProposal,
} from "../src/agents/hypothesis-authoring.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Message } from "../src/chat/message.js";
import { createGoal } from "../src/investigation/goal.js";
import { createInvestigation } from "../src/investigation/investigation.js";

/** Deterministic fake LLM with a canned completion and a call log. */
class FakeAuthorLLM implements LLMClient {
  calls: Message[][] = [];
  constructor(
    private readonly output: string,
    private readonly failure: Error | null = null,
  ) {}

  async *stream(_messages: Message[]): AsyncGenerator<string> {
    throw new Error("authoring tests never stream");
  }

  async complete(messages: Message[]): Promise<string> {
    this.calls.push(messages.map((m) => ({ ...m })));
    if (this.failure !== null) {
      throw this.failure;
    }
    return this.output;
  }
}

function seedInvestigation(id = "inv-1") {
  return createInvestigation(createGoal("Understand stale execution", "goal-1"), { id });
}

describe("parseHypothesisProposal", () => {
  it("extracts exactly one statement", () => {
    expect(parseHypothesisProposal("Hypothesis: Stale snapshots resurrect tasks.")).toEqual({
      statement: "Stale snapshots resurrect tasks.",
    });
  });

  it("tolerates surrounding whitespace but nothing else", () => {
    expect(parseHypothesisProposal("  \n  Hypothesis:   Stale snapshots.  \n\n")).toEqual({
      statement: "Stale snapshots.",
    });
  });

  it.each([
    ["empty output", ""],
    ["whitespace only", "   \n  "],
    ["missing field", "Stale snapshots resurrect tasks."],
    ["empty statement", "Hypothesis:    "],
    ["arbitrary prose", "I think the cache is the problem, honestly."],
    ["wrong key", "Statement: Stale snapshots."],
    ["lowercase key", "hypothesis: Stale snapshots."],
    ["extra field", "Hypothesis: Stale snapshots.\nConfidence: high"],
    ["smuggled id", "Hypothesis: Stale snapshots.\nID: hyp-1"],
    ["smuggled status", "Hypothesis: Stale snapshots.\nStatus: supported"],
    ["multiple records", "Hypothesis: First.\nHypothesis: Second."],
  ])("rejects %s", (_label, output) => {
    expect(() => parseHypothesisProposal(output)).toThrow(/proposal/i);
  });
});

describe("authorHypothesis", () => {
  it("authors exactly one candidate hypothesis and nothing else", async () => {
    const llm = new FakeAuthorLLM("Hypothesis: Stale snapshots resurrect tasks.");
    const before = seedInvestigation();

    const after = await authorHypothesis(llm, before, "Why do tasks resurrect?", {
      hypothesisId: "hyp-1",
    });

    expect(after.hypotheses).toEqual([
      { id: "hyp-1", statement: "Stale snapshots resurrect tasks.", status: "candidate" },
    ]);
    // Original snapshot and prior members untouched.
    expect(before.hypotheses).toEqual([]);
    expect(after).not.toBe(before);
    // Proposal-only semantics: no evidence, evaluation, plan, revision,
    // or status change accompanies the new candidate.
    expect(after.evidence).toEqual([]);
    expect(after.evaluations).toEqual([]);
    expect(after.experiments).toEqual([]);
    expect(after.falsifications).toEqual([]);
    expect(after.modelRevisions).toEqual([]);
    expect(after.status).toBe("unknown");
    expect(after).not.toHaveProperty("confidence");
  });

  it("preserves existing hypotheses in order", async () => {
    const llm = new FakeAuthorLLM("Hypothesis: Second explanation.");
    let before = seedInvestigation();
    before = await authorHypothesis(llm, before, "request one", { hypothesisId: "hyp-1" });

    const after = await authorHypothesis(
      new FakeAuthorLLM("Hypothesis: Third explanation."),
      before,
      "request two",
      { hypothesisId: "hyp-2" },
    );

    expect(after.hypotheses.map((h) => h.id)).toEqual(["hyp-1", "hyp-2"]);
    expect(after.hypotheses[1]).toEqual({
      id: "hyp-2",
      statement: "Third explanation.",
      status: "candidate",
    });
  });

  it("calls the model exactly once with goal context and the narrow contract", async () => {
    const llm = new FakeAuthorLLM("Hypothesis: Stale snapshots resurrect tasks.");

    await authorHypothesis(llm, seedInvestigation(), "Why do tasks resurrect?");

    expect(llm.calls).toHaveLength(1);
    const prompt = llm.calls[0]!.map((m) => m.content).join("\n");
    expect(prompt).toContain("Understand stale execution");
    expect(prompt).toContain("Why do tasks resurrect?");
    expect(prompt).toContain("Hypothesis: <one-line candidate explanation>");
    // Restraint is stated as prohibitions, never as requested output.
    expect(prompt).toContain("You are NOT answering the investigation");
  });

  it("leaves the investigation unchanged on LLM failure or malformed output", async () => {
    for (const llm of [
      new FakeAuthorLLM("", new Error("model down")),
      new FakeAuthorLLM(""),
      new FakeAuthorLLM("just some prose"),
      new FakeAuthorLLM("Hypothesis: First.\nHypothesis: Second."),
    ]) {
      const before = seedInvestigation(`inv-${llm.calls.length}`);
      const snapshot = structuredClone(before);

      await expect(authorHypothesis(llm, before, "Why?")).rejects.toThrow();
      expect(before).toEqual(snapshot);
    }
  });

  it("takes the hypothesis ID from the domain, never the model", async () => {
    const llm = new FakeAuthorLLM("Hypothesis: Stale snapshots.\nID: hyp-forged");

    // The smuggled ID line makes the whole response malformed: model
    // output can never choose identity.
    await expect(authorHypothesis(llm, seedInvestigation(), "Why?")).rejects.toThrow(/proposal/i);
  });

  it("introduces no runtime imports into the investigation domain", async () => {
    const module = await import("../src/agents/hypothesis-authoring.js");

    expect(Object.keys(module).sort()).toEqual([
      "authorHypothesis",
      "parseHypothesisProposal",
    ]);
  });
});
