import { describe, expect, it } from "vitest";
import { freezeResult } from "../src/agents/result.js";
import type { AgentResult } from "../src/agents/result.js";
import { agentResultToEvidence } from "../src/agents/result-evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvidence,
  addHypothesis,
  createInvestigation,
} from "../src/investigation/investigation.js";

function successfulResult(): AgentResult {
  // A settled execution that produced output: the closest the actual
  // result model has to "success" (there is no success flag — see below).
  return freezeResult("exec-1", "research", [
    { role: "assistant", content: "X causes Y" },
  ]);
}

describe("agentResultToEvidence", () => {
  it("converts a result with messages into Evidence", () => {
    const evidence = agentResultToEvidence(successfulResult(), { id: "ev-1" });

    expect(evidence).not.toBeNull();
    expect(evidence).toEqual({
      id: "ev-1",
      content: "X causes Y",
      source: { kind: "agent-assertion", agent: "research" },
      hypothesisIds: [],
    });
  });

  it("returns null for an empty result instead of inventing evidence", () => {
    // The actual AgentResult model has no success/failure flag:
    // failed AND empty executions both settle to `{ messages: [] }`.
    // With no output there is no claim to record, so a failed result
    // yields no evidence rather than fabricated content.
    const failed = freezeResult("exec-failed", "general", []);

    expect(agentResultToEvidence(failed)).toBeNull();
  });

  it("preserves provenance identifying the originating agent", () => {
    const evidence = agentResultToEvidence(
      freezeResult("exec-2", "coder", [{ role: "assistant", content: "fixed the leak" }]),
      { id: "ev-2" },
    );

    expect(evidence?.source).toEqual({ kind: "agent-assertion", agent: "coder" });
  });

  it("takes content from the result's actual messages, in order", () => {
    // MultiAgent publishes one message per completed child; the adapter
    // preserves all of them, never a reconstruction from events.
    const evidence = agentResultToEvidence(
      freezeResult("exec-multi", "multi", [
        { role: "assistant", content: "first finding" },
        { role: "assistant", content: "second finding" },
      ]),
      { id: "ev-multi" },
    );

    expect(evidence?.content).toBe("first finding\nsecond finding");
    expect(evidence?.id).not.toBe("exec-multi");
  });

  it("does NOT attach the converted Evidence to any hypothesis", () => {
    const evidence = agentResultToEvidence(successfulResult(), { id: "ev-1" });

    expect(evidence?.hypothesisIds).toEqual([]);
  });

  it("does NOT change Investigation.status when the evidence is gathered", () => {
    const goal = createGoal("Understand the outage", "goal-1");
    const investigation = addHypothesis(
      createInvestigation(goal, { id: "inv-1" }),
      createHypothesis("The cache is the cause", "hyp-1"),
    );
    const evidence = agentResultToEvidence(successfulResult(), { id: "ev-1" })!;

    const updated = addEvidence(investigation, evidence);

    expect(updated.status).toBe("unknown");
    // The linked hypothesis is untouched too: conversion evaluates nothing.
    expect(updated.hypotheses[0]?.status).toBe("candidate");
  });

  it("proves result output does NOT imply Investigation.succeeded", () => {
    const goal = createGoal("Understand the outage", "goal-1");
    const evidence = agentResultToEvidence(successfulResult(), { id: "ev-1" })!;
    const investigation = addEvidence(createInvestigation(goal, { id: "inv-1" }), evidence);

    // A result carrying output converted cleanly — and the investigation
    // still knows nothing. Only an explicit status change decides that.
    expect(evidence.content).toBe("X causes Y");
    expect(investigation.status).toBe("unknown");
    expect(investigation.status).not.toBe("succeeded");
  });

  it("does not mutate the AgentResult", () => {
    const result = successfulResult();
    const snapshot = structuredClone(result);

    agentResultToEvidence(result, { id: "ev-1" });

    expect(result).toEqual(snapshot);
  });

  it("returns Evidence following the Phase 1 immutability guarantees", () => {
    const evidence = agentResultToEvidence(successfulResult(), { id: "ev-1" })!;

    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.source)).toBe(true);
    expect(Object.isFrozen(evidence.hypothesisIds)).toBe(true);
  });
});
