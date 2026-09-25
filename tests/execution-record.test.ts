import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExecutionRecord } from "../src/agents/execution-record.js";
import { agentResultToEvidence } from "../src/agents/result-evidence.js";
import { freezeResult } from "../src/agents/result.js";
import {
  createEvaluateHypothesisAction,
  createFinishAction,
  createUndeterminedAction,
  decideNextInvestigationAction,
} from "../src/investigation/action.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvidence,
  addExecutionRecord,
  addHypothesis,
  createInvestigation,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "queue-probe" } as const;

function seedInvestigation(id = "inv-1") {
  let investigation = addHypothesis(
    createInvestigation(createGoal("Understand stale execution", "goal-1"), { id }),
    createHypothesis("Rotation prevents stale execution.", "hyp-1"),
  );
  return addEvidence(
    investigation,
    createEvidence("one pending action", { ...TOOL_SOURCE }, { id: "ev-1" }),
  );
}

function executedTriple() {
  const action = createEvaluateHypothesisAction("hyp-1", "ev-1", "act-1");
  const result = freezeResult("exec-1", "general", [
    { role: "assistant", content: "ev-1 supports the hypothesis: only one action was pending." },
  ]);
  const evidence = agentResultToEvidence(result, { id: "ev-2" })!;
  return { action, result, evidence };
}

describe("createExecutionRecord", () => {
  it("represents the action/result/evidence relationship explicitly", () => {
    const { action, result, evidence } = executedTriple();

    const record = createExecutionRecord(action, result, evidence, "rec-1");

    expect(record).toEqual({
      id: "rec-1",
      actionId: "act-1",
      hypothesisId: "hyp-1",
      resultId: "exec-1",
      evidenceId: "ev-2",
    });
  });

  it("reuses the stable action and execution identities instead of inventing new ones", () => {
    const { action, result, evidence } = executedTriple();

    const record = createExecutionRecord(action, result, evidence, "rec-1");

    // No new identity scheme: every id is one the members already had.
    expect(record.actionId).toBe(action.id);
    expect(record.resultId).toBe(result.id);
    expect(record.evidenceId).toBe(evidence.id);
    expect(record.id).toBe("rec-1");
  });

  it("carries no verdict: correlation is provenance, not judgment", () => {
    const { action, result, evidence } = executedTriple();

    const record = createExecutionRecord(action, result, evidence, "rec-1");

    expect(record).not.toHaveProperty("relation");
    expect(record).not.toHaveProperty("supports");
    expect(record).not.toHaveProperty("verdict");
    expect(record).not.toHaveProperty("status");
    expect(record).not.toHaveProperty("result");
  });

  it("refuses records for actions that request no execution", () => {
    const { result, evidence } = executedTriple();

    expect(() => createExecutionRecord(createFinishAction("act-9"), result, evidence, "rec-9")).toThrow(
      /requests no execution/,
    );
    expect(() =>
      createExecutionRecord(createUndeterminedAction("act-9"), result, evidence, "rec-9"),
    ).toThrow(/requests no execution/);
  });

  it("rejects empty record ids and empty result ids", () => {
    const { action, result, evidence } = executedTriple();

    expect(() => createExecutionRecord(action, result, evidence, "  ")).toThrow(/id/);
    expect(() =>
      createExecutionRecord(
        action,
        { ...result, id: "  " },
        evidence,
        "rec-1",
      ),
    ).toThrow(/non-empty id/);
  });

  it("records null evidence when the execution extracted nothing", () => {
    // Evaluation executions interpret existing evidence rather than
    // producing new evidence: the record keeps action/result lineage
    // with no extraction claim.
    const { action, result } = executedTriple();

    const record = createExecutionRecord(action, result, null, "rec-1");

    expect(record).toEqual({
      id: "rec-1",
      actionId: "act-1",
      hypothesisId: "hyp-1",
      resultId: "exec-1",
      evidenceId: null,
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("is frozen and creates no execution when sealing", () => {
    const { action, result, evidence } = executedTriple();
    const actionSnapshot = structuredClone(action);
    const resultSnapshot = structuredClone(result);
    const evidenceSnapshot = structuredClone(evidence);

    const record = createExecutionRecord(action, result, evidence, "rec-1");

    expect(Object.isFrozen(record)).toBe(true);
    expect(action).toEqual(actionSnapshot);
    expect(result).toEqual(resultSnapshot);
    expect(evidence).toEqual(evidenceSnapshot);
    // Pure data: JSON round-trip proves no callbacks or handles.
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

describe("execution records within an investigation", () => {
  it("answers the full lineage while H1 stays candidate", () => {
    // End-to-end composition with a fake execution result:
    // evaluate-hypothesis(H1) → request → R1 → E1 → correlation.
    let investigation = seedInvestigation();
    const action = decideNextInvestigationAction(investigation, { id: "act-1" });
    expect(action.kind).toBe("evaluate-hypothesis");

    const result = freezeResult("exec-1", "general", [
      { role: "assistant", content: "ev-1 supports the hypothesis: only one action was pending." },
    ]);
    const evidence = agentResultToEvidence(result, { id: "ev-2" })!;
    const record = createExecutionRecord(action, result, evidence, "rec-1");
    investigation = addEvidence(investigation, evidence);
    investigation = addExecutionRecord(investigation, record);

    // "Why does ev-2 exist?" — fully answerable from final state:
    const stored = investigation.executionRecords[0]!;
    expect(stored.evidenceId).toBe("ev-2");
    expect(stored.actionId).toBe("act-1");
    expect(stored.resultId).toBe("exec-1");
    expect(stored.hypothesisId).toBe("hyp-1");

    // ...while judgment stays explicitly separate:
    expect(evidence.hypothesisIds).toEqual([]);
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
    expect(investigation.status).toBe("unknown");
  });

  it("keeps evidence ordinary until an explicit evaluation exists", () => {
    const { evidence } = executedTriple();

    // The agent's prose may read like support; the domain disagrees
    // until an EvidenceEvaluation says otherwise.
    expect(evidence.content).toContain("supports the hypothesis");
    expect(evidence.hypothesisIds).toEqual([]);
    expect(evidence.source).toEqual({ kind: "agent-assertion", agent: "general" });
  });

  it("leaves prior snapshots unchanged and rejects duplicate record ids", () => {
    const { action, result, evidence } = executedTriple();
    expect(seedInvestigation().executionRecords).toEqual([]);

    const before = seedInvestigation();
    const snapshot = structuredClone(before);
    const after = addExecutionRecord(before, createExecutionRecord(action, result, evidence, "rec-1"));

    expect(before).toEqual(snapshot);
    expect(after.executionRecords).toHaveLength(1);
    expect(after).not.toBe(before);
    expect(() =>
      addExecutionRecord(after, createExecutionRecord(action, result, evidence, "rec-1")),
    ).toThrow(/Duplicate executionRecord id/);
  });

  it("reuses the unchanged AgentResult → Evidence behavior", () => {
    const { result } = executedTriple();

    // Existing adapter semantics pinned: unlinked agent-assertion, and
    // empty results still yield no evidence at all.
    expect(agentResultToEvidence(result, { id: "ev-2" })).toEqual({
      id: "ev-2",
      content: "ev-1 supports the hypothesis: only one action was pending.",
      source: { kind: "agent-assertion", agent: "general" },
      hypothesisIds: [],
    });
    expect(agentResultToEvidence(freezeResult("exec-empty", "general", []))).toBeNull();
  });

  it("keeps runtime imports out of src/investigation/*", () => {
    const dir = new URL("../src/investigation/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

    expect(files).toContain("execution-record.ts");
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source).not.toMatch(/from ["']\.\.\/(agents|chat|llm)\//);
      expect(source).not.toMatch(/from ["'](openai|ink|react)["']/);
      expect(source).not.toContain(".run(");
    }
  });
});
