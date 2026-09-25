import { describe, expect, it } from "vitest";
import { createEvidence } from "../src/investigation/evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import { createInvariant } from "../src/investigation/invariant.js";
import { createModelRevision } from "../src/investigation/model-revision.js";
import {
  addEvidence,
  addHypothesis,
  addInvariant,
  addModelRevision,
  createInvestigation,
} from "../src/investigation/investigation.js";

const PREVIOUS_MODEL = "pairingGeneration prevents stale accepted actions.";
const NEW_MODEL =
  "pairingGeneration controls routing of new pulls but does not invalidate already-accepted work.";
const REASON =
  "Evidence-42 demonstrates that an already-accepted action can survive generation rotation.";

function seedInvestigation(id = "inv-1") {
  const goal = createGoal("Understand stale execution", "goal-1");
  let investigation = addEvidence(
    createInvestigation(goal, { id }),
    createEvidence(
      "An already-accepted action survived generation rotation.",
      { kind: "tool-result", tool: "rotation-probe" },
      { id: "evidence-42" },
    ),
  );
  investigation = addHypothesis(
    investigation,
    createHypothesis("Generation rotation prevents stale execution.", "hyp-1"),
  );
  return addInvariant(
    investigation,
    createInvariant("Every accepted action has exactly one owner.", "rule-1"),
  );
}

function firstRevision() {
  return createModelRevision(PREVIOUS_MODEL, NEW_MODEL, ["evidence-42"], REASON, "rev-1");
}

describe("ModelRevision", () => {
  it("creates a revision preserving previous model, new model, triggers, and reason", () => {
    const revision = firstRevision();

    expect(revision).toEqual({
      id: "rev-1",
      previousModel: PREVIOUS_MODEL,
      newModel: NEW_MODEL,
      triggerEvidenceIds: ["evidence-42"],
      reason: REASON,
    });
  });

  it("references evidence by ID without embedding it", () => {
    const revision = firstRevision();

    expect(revision.triggerEvidenceIds).toEqual(["evidence-42"]);
    expect(revision).not.toHaveProperty("evidence");
    expect(revision).not.toHaveProperty("content");
  });

  it("is not a hypothesis and carries no standing", () => {
    const revision = firstRevision();

    expect(revision).not.toHaveProperty("statement");
    expect(revision).not.toHaveProperty("status");
    expect(revision).not.toHaveProperty("hypothesisId");
  });

  it("rejects empty model strings", () => {
    expect(() => createModelRevision("   ", NEW_MODEL, ["evidence-42"], REASON, "rev-1")).toThrow(
      /previousModel/,
    );
    expect(() => createModelRevision(PREVIOUS_MODEL, "  ", ["evidence-42"], REASON, "rev-1")).toThrow(
      /newModel/,
    );
  });

  it("rejects identical models: no change means no revision", () => {
    expect(() =>
      createModelRevision(PREVIOUS_MODEL, PREVIOUS_MODEL, ["evidence-42"], REASON, "rev-1"),
    ).toThrow(/requires a change/);
  });

  it("requires trigger evidence and rejects invalid evidence ids", () => {
    expect(() => createModelRevision(PREVIOUS_MODEL, NEW_MODEL, [], REASON, "rev-1")).toThrow(
      /at least one trigger evidence id/,
    );
    expect(() => createModelRevision(PREVIOUS_MODEL, NEW_MODEL, ["  "], REASON, "rev-1")).toThrow(
      /triggerEvidenceIds/,
    );
  });

  it("rejects empty reasons and empty ids", () => {
    expect(() => createModelRevision(PREVIOUS_MODEL, NEW_MODEL, ["evidence-42"], "   ", "rev-1")).toThrow(
      /reason/,
    );
    expect(() => createModelRevision(PREVIOUS_MODEL, NEW_MODEL, ["evidence-42"], REASON, "  ")).toThrow(
      /id/,
    );
  });

  it("is frozen according to the Phase 1 conventions", () => {
    const revision = firstRevision();

    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.triggerEvidenceIds)).toBe(true);
  });
});

describe("model revisions within an investigation", () => {
  it("chains revisions while preserving every earlier record", () => {
    let investigation = seedInvestigation();
    investigation = addModelRevision(investigation, firstRevision());
    investigation = addModelRevision(
      investigation,
      createModelRevision(
        NEW_MODEL,
        "Accepted work requires a separate execution barrier alongside the routing fence.",
        ["evidence-42"],
        "The routing-only model cannot explain post-rotation executability.",
        "rev-2",
      ),
    );

    expect(investigation.modelRevisions.map((r) => r.id)).toEqual(["rev-1", "rev-2"]);
    // Revision 2 continues where revision 1 ended; revision 1 is unchanged.
    expect(investigation.modelRevisions[1]?.previousModel).toBe(
      investigation.modelRevisions[0]?.newModel,
    );
    expect(investigation.modelRevisions[0]).toEqual(firstRevision());
  });

  it("changes nothing else when a revision is recorded", () => {
    const before = seedInvestigation();
    const evidenceSnapshot = structuredClone(before.evidence);
    const hypothesisSnapshot = structuredClone(before.hypotheses);
    const invariantSnapshot = structuredClone(before.invariants);

    const after = addModelRevision(before, firstRevision());

    expect(after.evidence).toEqual(evidenceSnapshot);
    expect(after.hypotheses).toEqual(hypothesisSnapshot);
    expect(after.invariants).toEqual(invariantSnapshot);
    // In particular: no new hypothesis appears and none changes standing.
    expect(after.hypotheses).toHaveLength(1);
    expect(after.hypotheses[0]?.status).toBe("candidate");
    expect(after.status).toBe("unknown");
  });

  it("starts empty, rejects duplicate revision ids, and keeps prior snapshots intact", () => {
    expect(seedInvestigation().modelRevisions).toEqual([]);

    const before = seedInvestigation();
    const snapshot = structuredClone(before);
    const after = addModelRevision(before, firstRevision());

    expect(before).toEqual(snapshot);
    expect(before.modelRevisions).toEqual([]);
    expect(after.modelRevisions).toEqual([firstRevision()]);
    expect(after).not.toBe(before);

    expect(() => addModelRevision(after, firstRevision())).toThrow(/Duplicate modelRevision id/);
  });
});
