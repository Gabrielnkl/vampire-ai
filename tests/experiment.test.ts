import { describe, expect, it } from "vitest";
import { createExperiment } from "../src/investigation/experiment.js";
import { createFalsification } from "../src/investigation/falsification.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addExperiment,
  addFalsification,
  addHypothesis,
  createInvestigation,
} from "../src/investigation/investigation.js";

const HYPOTHESIS_ID = "hyp-1";
const FALSIFICATION_ID = "fals-1";
const PROCEDURE =
  "Submit the stale snapshot to the registry under the current generation fence and record whether it is accepted or rejected.";

function seedInvestigation(id = "inv-1") {
  const goal = createGoal("Determine why a task occasionally resurrects after shutdown.", "goal-1");
  let investigation = addHypothesis(
    createInvestigation(goal, { id }),
    createHypothesis("A stale snapshot can reintroduce a previously completed task.", HYPOTHESIS_ID),
  );
  return addFalsification(
    investigation,
    createFalsification(
      HYPOTHESIS_ID,
      "If the task registry rejects the stale snapshot under the relevant generation fence, H1 is contradicted.",
      FALSIFICATION_ID,
    ),
  );
}

describe("Experiment", () => {
  it("creates a valid experiment plan", () => {
    const experiment = createExperiment(HYPOTHESIS_ID, PROCEDURE, {
      falsificationId: FALSIFICATION_ID,
      id: "exp-1",
    });

    expect(experiment).toEqual({
      id: "exp-1",
      hypothesisId: HYPOTHESIS_ID,
      falsificationId: FALSIFICATION_ID,
      procedure: PROCEDURE,
    });
  });

  it("is frozen according to the repository conventions", () => {
    const experiment = createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "exp-1" });

    expect(Object.isFrozen(experiment)).toBe(true);
  });

  it("rejects empty experiment IDs, hypothesis IDs, and procedures", () => {
    expect(() => createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "  " })).toThrow(/id/);
    expect(() => createExperiment("   ", PROCEDURE, { id: "exp-1" })).toThrow(/hypothesisId/);
    expect(() => createExperiment(HYPOTHESIS_ID, "   ", { id: "exp-1" })).toThrow(/procedure/);
  });

  it("accepts a null falsification ID for exploratory work", () => {
    const implicit = createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "exp-1" });
    const explicit = createExperiment(HYPOTHESIS_ID, PROCEDURE, { falsificationId: null, id: "exp-2" });

    expect(implicit.falsificationId).toBeNull();
    expect(explicit.falsificationId).toBeNull();
  });

  it("preserves a valid falsification ID and rejects an empty one", () => {
    const experiment = createExperiment(HYPOTHESIS_ID, PROCEDURE, {
      falsificationId: FALSIFICATION_ID,
      id: "exp-1",
    });

    expect(experiment.falsificationId).toBe(FALSIFICATION_ID);
    expect(() =>
      createExperiment(HYPOTHESIS_ID, PROCEDURE, { falsificationId: "  ", id: "exp-1" }),
    ).toThrow(/falsificationId/);
  });

  it("allows multiple experiments to target the same hypothesis", () => {
    const first = createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "exp-1" });
    const second = createExperiment(HYPOTHESIS_ID, "Replay the shutdown sequence and watch the registry.", {
      falsificationId: FALSIFICATION_ID,
      id: "exp-2",
    });

    expect(first.hypothesisId).toBe(HYPOTHESIS_ID);
    expect(second.hypothesisId).toBe(HYPOTHESIS_ID);
    expect(first.id).not.toBe(second.id);
  });

  it("references members by ID rather than embedding domain objects", () => {
    const experiment = createExperiment(HYPOTHESIS_ID, PROCEDURE, {
      falsificationId: FALSIFICATION_ID,
      id: "exp-1",
    });

    expect(experiment).not.toHaveProperty("hypothesis");
    expect(experiment).not.toHaveProperty("falsification");
    expect(experiment).not.toHaveProperty("criterion");
    expect(typeof experiment.hypothesisId).toBe("string");
  });
});

describe("experiment as an inert plan", () => {
  it("describes work without containing a verdict", () => {
    const experiment = createExperiment(HYPOTHESIS_ID, PROCEDURE, {
      falsificationId: FALSIFICATION_ID,
      id: "exp-1",
    });

    for (const word of ["supports", "contradicts", "refuted", "success", "failure"]) {
      expect(experiment.procedure).not.toContain(word);
      expect(experiment).not.toHaveProperty(word);
    }
    expect(experiment).not.toHaveProperty("status");
    expect(experiment).not.toHaveProperty("result");
    expect(experiment).not.toHaveProperty("observation");
    expect(experiment).not.toHaveProperty("evidence");
  });

  it("has zero epistemic effect when created and stored", () => {
    const before = seedInvestigation();
    const experiment = createExperiment(HYPOTHESIS_ID, PROCEDURE, {
      falsificationId: FALSIFICATION_ID,
      id: "exp-1",
    });
    const after = addExperiment(before, experiment);

    // The plan describes how evidence COULD be produced; nothing was.
    expect(after.hypotheses[0]?.status).toBe("candidate");
    expect(after.status).toBe("unknown");
    expect(after.evidence).toEqual([]);
    expect(after.observations).toEqual([]);
    // Pure data: JSON round-trip proves no execution hides in it.
    expect(JSON.parse(JSON.stringify(experiment))).toEqual(experiment);
  });
});

describe("experiments within an investigation", () => {
  it("appends to a new snapshot while preserving the original", () => {
    const before = seedInvestigation();
    const snapshot = structuredClone(before);

    const after = addExperiment(
      before,
      createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "exp-1" }),
    );

    expect(before).toEqual(snapshot);
    expect(before.experiments).toEqual([]);
    expect(after.experiments).toHaveLength(1);
    expect(after).not.toBe(before);
  });

  it("rejects duplicate experiment IDs and preserves insertion order", () => {
    expect(seedInvestigation().experiments).toEqual([]);

    let investigation = seedInvestigation();
    investigation = addExperiment(investigation, createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "exp-1" }));
    investigation = addExperiment(
      investigation,
      createExperiment(HYPOTHESIS_ID, "Replay the shutdown sequence and watch the registry.", { id: "exp-2" }),
    );

    expect(investigation.experiments.map((e) => e.id)).toEqual(["exp-1", "exp-2"]);
    expect(() =>
      addExperiment(investigation, createExperiment(HYPOTHESIS_ID, PROCEDURE, { id: "exp-1" })),
    ).toThrow(/Duplicate experiment id/);
  });
});
