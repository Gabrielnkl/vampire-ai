import { describe, expect, it } from "vitest";
import {
  applyEvaluation,
  createEvaluation,
} from "../src/investigation/evaluation.js";
import { createEvidence, linkEvidenceToHypothesis } from "../src/investigation/evidence.js";
import {
  createHypothesis,
  transitionHypothesis,
} from "../src/investigation/hypothesis.js";
import { createGoal } from "../src/investigation/goal.js";
import {
  addEvidence,
  addHypothesis,
  createInvestigation,
  updateHypothesis,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "restart-probe" } as const;

function restartEvidence() {
  return createEvidence(
    "Restarting the process removed the stale action.",
    { ...TOOL_SOURCE },
    { id: "ev-1" },
  );
}

describe("EvidenceEvaluation", () => {
  it("relates one evidence to one hypothesis with a relation and reasoning", () => {
    const evaluation = createEvaluation("ev-1", "hyp-1", "supports", "The stale action vanished right after the restart.", "eval-1");

    expect(evaluation).toEqual({
      id: "eval-1",
      evidenceId: "ev-1",
      hypothesisId: "hyp-1",
      relation: "supports",
      reasoning: "The stale action vanished right after the restart.",
    });
  });

  it.each([
    ["supports"],
    ["contradicts"],
    ["inconclusive"],
  ] as const)("expresses the %s relation", (relation) => {
    const evaluation = createEvaluation("ev-1", "hyp-1", relation, "Considered against the hypothesis.", `eval-${relation}`);

    expect(evaluation.relation).toBe(relation);
  });

  it("lets the same evidence speak differently against different hypotheses", () => {
    // Evidence != interpretation: one evidence, two evaluations.
    const againstInvalidation = createEvaluation(
      "ev-1",
      "hyp-a",
      "supports",
      "Restart cleared state the hypothesis claims restarts invalidate.",
      "eval-a",
    );
    const againstTtl = createEvaluation(
      "ev-1",
      "hyp-b",
      "inconclusive",
      "The observation says nothing about TTL expiry timing.",
      "eval-b",
    );

    expect(againstInvalidation.evidenceId).toBe("ev-1");
    expect(againstTtl.evidenceId).toBe("ev-1");
    expect(againstInvalidation.relation).toBe("supports");
    expect(againstTtl.relation).toBe("inconclusive");
  });

  it("is frozen against mutation", () => {
    const evaluation = createEvaluation("ev-1", "hyp-1", "supports", "Directly observed.", "eval-1");

    expect(Object.isFrozen(evaluation)).toBe(true);
  });

  it("rejects empty ids, empty reasoning, and unknown relations", () => {
    expect(() => createEvaluation("  ", "hyp-1", "supports", "Why.", "eval-1")).toThrow(/evidenceId/);
    expect(() => createEvaluation("ev-1", "  ", "supports", "Why.", "eval-1")).toThrow(/hypothesisId/);
    expect(() => createEvaluation("ev-1", "hyp-1", "supports", "   ", "eval-1")).toThrow(/reasoning/);
    expect(() =>
      createEvaluation("ev-1", "hyp-1", "proves" as "supports", "Why.", "eval-1"),
    ).toThrow(/Invalid evaluation relation/);
  });
});

describe("applyEvaluation", () => {
  it("moves a candidate to supported on a supporting evaluation", () => {
    const hypothesis = createHypothesis("Restart invalidates previously accepted actions.", "hyp-1");
    const evaluation = createEvaluation("ev-1", "hyp-1", "supports", "The stale action vanished right after the restart.", "eval-1");

    expect(applyEvaluation(hypothesis, evaluation).status).toBe("supported");
  });

  it("moves a candidate to refuted on a contradicting evaluation", () => {
    const hypothesis = createHypothesis("The action was removed because its TTL expired.", "hyp-1");
    const evaluation = createEvaluation("ev-1", "hyp-1", "contradicts", "The action had no TTL configured.", "eval-1");

    expect(applyEvaluation(hypothesis, evaluation).status).toBe("refuted");
  });

  it("moves a candidate to inconclusive on an inconclusive evaluation", () => {
    const hypothesis = createHypothesis("The action was removed because its TTL expired.", "hyp-1");
    const evaluation = createEvaluation("ev-1", "hyp-1", "inconclusive", "The observation says nothing about TTL timing.", "eval-1");

    expect(applyEvaluation(hypothesis, evaluation).status).toBe("inconclusive");
  });

  it("keeps existing invalid transitions invalid", () => {
    // Phase 1 forbids returning to `candidate`; no relation maps there,
    // and the underlying rule is untouched.
    const supported = transitionHypothesis(createHypothesis("Restart invalidates actions.", "hyp-1"), "supported");

    expect(() => transitionHypothesis(supported, "candidate")).toThrow(
      /Invalid hypothesis transition/,
    );
  });

  it("keeps refuted hypotheses represented and revisable", () => {
    const refuted = applyEvaluation(
      createHypothesis("TTL expiry removed the action.", "hyp-1"),
      createEvaluation("ev-1", "hyp-1", "contradicts", "No TTL was configured.", "eval-1"),
    );

    expect(refuted.status).toBe("refuted");
    expect(refuted.statement).toBe("TTL expiry removed the action.");

    // supported != proven permanently: later evidence may revise it back.
    const revised = applyEvaluation(
      refuted,
      createEvaluation("ev-2", "hyp-1", "supports", "A hidden default TTL was found.", "eval-2"),
    );

    expect(revised.status).toBe("supported");
    expect(refuted.status).toBe("refuted");
  });

  it("rejects applying an evaluation to a different hypothesis", () => {
    const hypothesis = createHypothesis("Restart invalidates actions.", "hyp-1");
    const other = createEvaluation("ev-1", "hyp-other", "supports", "Why.", "eval-1");

    expect(() => applyEvaluation(hypothesis, other)).toThrow(/cannot be applied/);
  });

  it("does not mutate the original evidence or hypothesis", () => {
    const evidence = restartEvidence();
    const hypothesis = createHypothesis("Restart invalidates previously accepted actions.", "hyp-1");
    const evidenceSnapshot = structuredClone(evidence);
    const hypothesisSnapshot = structuredClone(hypothesis);
    const evaluation = createEvaluation("ev-1", "hyp-1", "supports", "Vanished right after restart.", "eval-1");

    applyEvaluation(hypothesis, evaluation);

    expect(evidence).toEqual(evidenceSnapshot);
    expect(hypothesis).toEqual(hypothesisSnapshot);
  });
});

describe("evaluation within an investigation", () => {
  it("leaves the investigation unknown unless an explicit status operation runs", () => {
    const goal = createGoal("Understand the stale action", "goal-1");
    let investigation = addEvidence(
      addHypothesis(
        createInvestigation(goal, { id: "inv-1" }),
        createHypothesis("Restart invalidates previously accepted actions.", "hyp-1"),
      ),
      restartEvidence(),
    );

    const evaluated = applyEvaluation(
      investigation.hypotheses[0]!,
      createEvaluation("ev-1", "hyp-1", "supports", "Vanished right after restart.", "eval-1"),
    );
    investigation = updateHypothesis(investigation, evaluated);

    expect(investigation.hypotheses[0]?.status).toBe("supported");
    expect(investigation.status).toBe("unknown");
  });

  it("does not make attached evidence supporting on its own", () => {
    // Attaching relates ("bears on") without deciding: only an
    // evaluation plus applyEvaluation changes standing, and the verdict
    // never lands on the evidence object itself.
    const linked = linkEvidenceToHypothesis(restartEvidence(), "hyp-1");

    expect(linked.hypothesisIds).toEqual(["hyp-1"]);
    expect(linked).not.toHaveProperty("relation");
    expect(linked).not.toHaveProperty("supports");
    expect(linked).not.toHaveProperty("verdict");
    expect(createHypothesis("Restart invalidates previously accepted actions.", "hyp-1").status).toBe(
      "candidate",
    );
  });
});
