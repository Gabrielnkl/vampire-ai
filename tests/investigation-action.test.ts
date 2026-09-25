import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createEvaluateHypothesisAction,
  createFinishAction,
  createUndeterminedAction,
  decideNextInvestigationAction,
} from "../src/investigation/action.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import {
  applyEvaluation,
  createEvaluation,
} from "../src/investigation/evaluation.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import { transitionHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvaluation,
  addEvidence,
  addHypothesis,
  createInvestigation,
  setInvestigationStatus,
  updateHypothesis,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "queue-probe" } as const;

function seedInvestigation(id = "inv-1") {
  return createInvestigation(createGoal("Understand stale execution", "goal-1"), { id });
}

function withCandidateAndEvidence() {
  let investigation = addHypothesis(
    seedInvestigation(),
    createHypothesis("Rotation prevents stale execution.", "hyp-1"),
  );
  return addEvidence(
    investigation,
    createEvidence("one pending action", { ...TOOL_SOURCE }, { id: "ev-1" }),
  );
}

describe("InvestigationAction representation", () => {
  it("uses an intentionally minimal vocabulary", () => {
    // Three kinds, each structurally justified — no prioritized testing,
    // auto-revision, experiment dispatch, or agent routing.
    expect(createEvaluateHypothesisAction("hyp-1", "ev-1", "act-1")).toEqual({
      id: "act-1",
      kind: "evaluate-hypothesis",
      hypothesisId: "hyp-1",
      evidenceId: "ev-1",
    });
    expect(createFinishAction("act-2")).toEqual({ id: "act-2", kind: "finish" });
    expect(createUndeterminedAction("act-3")).toEqual({ id: "act-3", kind: "undetermined" });
  });

  it("is frozen and keeps explicitly supplied IDs stable", () => {
    const actions = [
      createEvaluateHypothesisAction("hyp-1", "ev-1", "act-1"),
      createFinishAction("act-2"),
      createUndeterminedAction("act-3"),
    ];

    for (const action of actions) {
      expect(Object.isFrozen(action)).toBe(true);
      expect(action.id).toMatch(/^act-[123]$/);
    }
  });

  it("references domain members by ID, never by embedded object", () => {
    const action = createEvaluateHypothesisAction("hyp-1", "ev-1", "act-1");

    expect(action).not.toHaveProperty("hypothesis");
    expect(action).not.toHaveProperty("statement");
    expect(action).not.toHaveProperty("evidence");
    expect(action).not.toHaveProperty("content");
    if (action.kind === "evaluate-hypothesis") {
      expect(typeof action.hypothesisId).toBe("string");
      expect(typeof action.evidenceId).toBe("string");
    } else {
      throw new Error("expected an evaluate-hypothesis action");
    }
  });

  it("rejects invalid required fields", () => {
    expect(() => createEvaluateHypothesisAction("   ", "ev-1", "act-1")).toThrow(/hypothesisId/);
    expect(() => createEvaluateHypothesisAction("hyp-1", "   ", "act-1")).toThrow(/evidenceId/);
    expect(() => createEvaluateHypothesisAction("hyp-1", "ev-1", "  ")).toThrow(/id/);
    expect(() => createFinishAction("  ")).toThrow(/id/);
    expect(() => createUndeterminedAction("")).toThrow(/id/);
  });

  it("is pure data: no execution can hide in it", () => {
    const investigation = withCandidateAndEvidence();
    const actions = [
      decideNextInvestigationAction(investigation, { id: "act-1" }),
      createFinishAction("act-2"),
      createUndeterminedAction("act-3"),
    ];

    for (const action of actions) {
      // JSON round-trip proves plain data: no callbacks, no handles.
      expect(JSON.parse(JSON.stringify(action))).toEqual(action);
      for (const value of Object.values(action)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });

  it("introduces no LLM/agent/runtime/TUI dependency", () => {
    const source = readFileSync(new URL("../src/investigation/action.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/from ["']\.\.\/(agents|chat|llm)\//);
    expect(source).not.toMatch(/from ["'](openai|ink|react)["']/);
  });
});

describe("decideNextInvestigationAction", () => {
  it("is deterministic: the same snapshot yields the same decision", () => {
    const investigation = withCandidateAndEvidence();

    const first = decideNextInvestigationAction(investigation, { id: "act-1" });
    const second = decideNextInvestigationAction(investigation, { id: "act-1" });

    expect(first).toEqual(second);
    expect(first).toEqual({ id: "act-1", kind: "evaluate-hypothesis", hypothesisId: "hyp-1", evidenceId: "ev-1" });
  });

  it("derives the same kind and references without an explicit id", () => {
    const investigation = withCandidateAndEvidence();

    const first = decideNextInvestigationAction(investigation);
    const second = decideNextInvestigationAction(investigation);

    expect(first.kind).toBe("evaluate-hypothesis");
    expect(first).toEqual({ ...second, id: first.id });
  });

  it("requests evaluation of the first candidate when evidence exists", () => {
    let investigation = addHypothesis(
      seedInvestigation(),
      createHypothesis("First explanation.", "hyp-1"),
    );
    investigation = addHypothesis(
      investigation,
      createHypothesis("Second explanation.", "hyp-2"),
    );
    investigation = addEvidence(
      investigation,
      createEvidence("one pending action", { ...TOOL_SOURCE }, { id: "ev-1" }),
    );

    // First pending pair in investigation order — deterministic, with
    // no claim that it is the optimal pair to evaluate.
    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "evaluate-hypothesis",
      hypothesisId: "hyp-1",
      evidenceId: "ev-1",
    });
  });

  it("finishes only on explicit status, even with pending work present", () => {
    const pending = withCandidateAndEvidence();

    expect(
      decideNextInvestigationAction(setInvestigationStatus(pending, "succeeded"), { id: "act-1" }),
    ).toEqual({ id: "act-1", kind: "finish" });
    expect(
      decideNextInvestigationAction(setInvestigationStatus(pending, "failed"), { id: "act-2" }),
    ).toEqual({ id: "act-2", kind: "finish" });
  });

  it("never infers success: supported hypotheses and evidence do not finish", () => {
    // A supported hypothesis with recorded evidence is still an
    // undetermined investigation until an explicit status change —
    // even though the unevaluated pair now requests re-evaluation.
    let investigation = withCandidateAndEvidence();
    const evaluated = applyEvaluation(
      investigation.hypotheses[0]!,
      createEvaluation("ev-1", "hyp-1", "supports", "Directly observed.", "eval-1"),
    );
    investigation = addEvaluation(
      updateHypothesis(investigation, evaluated),
      createEvaluation("ev-1", "hyp-1", "supports", "Directly observed.", "eval-1"),
    );

    expect(investigation.hypotheses[0]?.status).toBe("supported");
    expect(investigation.status).toBe("unknown");
    // Pair already judged: nothing pending remains.
    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "undetermined",
    });
  });

  it("revisits evaluated hypotheses while unevaluated pairs remain", () => {
    // Standing gates nothing: a supported hypothesis with fresh,
    // never-evaluated evidence requests interpretation, which is how
    // revisability happens.
    let investigation = withCandidateAndEvidence();
    const first = createEvaluation("ev-1", "hyp-1", "supports", "Directly observed.", "eval-1");
    const evaluated = applyEvaluation(investigation.hypotheses[0]!, first);
    investigation = addEvaluation(updateHypothesis(investigation, evaluated), first);
    investigation = addEvidence(
      investigation,
      createEvidence("second sighting", { ...TOOL_SOURCE }, { id: "ev-2" }),
    );

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "evaluate-hypothesis",
      hypothesisId: "hyp-1",
      evidenceId: "ev-2",
    });
  });

  it("is undetermined when there is nothing to evaluate yet", () => {
    // Empty investigation, and candidates with no evidence against them:
    // requesting evaluation would fabricate work from nothing.
    expect(decideNextInvestigationAction(seedInvestigation(), { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "undetermined",
    });

    const candidateOnly = addHypothesis(
      seedInvestigation(),
      createHypothesis("Rotation prevents stale execution.", "hyp-1"),
    );
    expect(decideNextInvestigationAction(candidateOnly, { id: "act-2" })).toEqual({
      id: "act-2",
      kind: "undetermined",
    });
  });

  it("does not mutate the investigation or anything it contains", () => {
    const investigation = withCandidateAndEvidence();
    const snapshot = structuredClone(investigation);

    decideNextInvestigationAction(investigation, { id: "act-1" });

    expect(investigation).toEqual(snapshot);
    expect(investigation.hypotheses).toEqual(snapshot.hypotheses);
    expect(investigation.evidence).toEqual(snapshot.evidence);
    expect(investigation.evaluations).toEqual(snapshot.evaluations);
    expect(investigation.invariants).toEqual(snapshot.invariants);
    expect(investigation.invariantChecks).toEqual(snapshot.invariantChecks);
    expect(investigation.falsifications).toEqual(snapshot.falsifications);
    expect(investigation.modelRevisions).toEqual(snapshot.modelRevisions);
    expect(investigation.status).toBe("unknown");
  });
});

describe("decideNextInvestigationAction: pending pairs", () => {
  function twoHypothesesOneEvidence() {
    let investigation = addHypothesis(
      seedInvestigation(),
      createHypothesis("First explanation.", "hyp-1"),
    );
    investigation = addHypothesis(
      investigation,
      createHypothesis("Second explanation.", "hyp-2"),
    );
    return addEvidence(
      investigation,
      createEvidence("one pending action", { ...TOOL_SOURCE }, { id: "ev-1" }),
    );
  }

  it("moves to the next hypothesis once a pair is judged", () => {
    const judged = addEvaluation(
      twoHypothesesOneEvidence(),
      createEvaluation("ev-1", "hyp-1", "supports", "Directly observed.", "eval-1"),
    );

    // (ev-1, hyp-1) answered; (ev-1, hyp-2) pending regardless of hyp-2's standing.
    expect(decideNextInvestigationAction(judged, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "evaluate-hypothesis",
      hypothesisId: "hyp-2",
      evidenceId: "ev-1",
    });
  });

  it("treats refuted and inconclusive standings as evaluable", () => {
    for (const next of ["refuted", "inconclusive"] as const) {
      let investigation = withCandidateAndEvidence();
      investigation = updateHypothesis(
        investigation,
        transitionHypothesis(investigation.hypotheses[0]!, next),
      );

      expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
        id: "act-1",
        kind: "evaluate-hypothesis",
        hypothesisId: "hyp-1",
        evidenceId: "ev-1",
      });
    }
  });

  it("is undetermined once every pair has been judged", () => {
    let investigation = addEvaluation(
      twoHypothesesOneEvidence(),
      createEvaluation("ev-1", "hyp-1", "supports", "Directly observed.", "eval-1"),
    );
    investigation = addEvaluation(
      investigation,
      createEvaluation("ev-1", "hyp-2", "inconclusive", "Says nothing about hyp-2.", "eval-2"),
    );

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "undetermined",
    });
  });
  it("ignores linkage metadata when finding pending pairs", () => {
    // hypothesisIds linkage is metadata, never an eligibility gate:
    // an unlinked pair is still pending, a judged pair is still done.
    const investigation = twoHypothesesOneEvidence();

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "evaluate-hypothesis",
      hypothesisId: "hyp-1",
      evidenceId: "ev-1",
    });
  });

  it("never gates eligibility on evidence source", () => {
    // Pending is pending regardless of provenance: agent assertions,
    // tool output, and user reports are all equally evaluable. No
    // source-kind scheduler policy exists.
    const sources = [
      { kind: "agent-assertion", agent: "research" },
      { kind: "tool-result", tool: "probe" },
      { kind: "user-provided" },
    ] as const;
    for (const [index, source] of sources.entries()) {
      let investigation = addHypothesis(
        seedInvestigation(`inv-source-${index}`),
        createHypothesis("Rotation prevents stale execution.", "hyp-1"),
      );
      investigation = addEvidence(
        investigation,
        createEvidence("sighting", { ...source }, { id: `ev-source-${index}` }),
      );

      expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
        id: "act-1",
        kind: "evaluate-hypothesis",
        hypothesisId: "hyp-1",
        evidenceId: `ev-source-${index}`,
      });
    }
  });
});
