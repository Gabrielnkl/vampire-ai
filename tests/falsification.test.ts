import { describe, expect, it } from "vitest";
import { createFalsification } from "../src/investigation/falsification.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addFalsification,
  addHypothesis,
  createInvestigation,
} from "../src/investigation/investigation.js";

const HYPOTHESIS_ID = "hyp-1";
const CRITERION =
  "If an already-accepted action executes after generation rotation, this hypothesis is false.";

function seedInvestigation(id = "inv-1") {
  const goal = createGoal("Understand stale execution", "goal-1");
  return addHypothesis(
    createInvestigation(goal, { id }),
    createHypothesis("pairingGeneration prevents already-accepted actions from executing after generation rotation.", HYPOTHESIS_ID),
  );
}

describe("Falsification", () => {
  it("creates a criterion with a stable identity", () => {
    const falsification = createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1");

    expect(falsification).toEqual({ id: "fals-1", hypothesisId: HYPOTHESIS_ID, criterion: CRITERION });
  });

  it("references its hypothesis by ID, not by embedded object", () => {
    const falsification = createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1");

    expect(falsification.hypothesisId).toBe(HYPOTHESIS_ID);
    expect(falsification).not.toHaveProperty("hypothesis");
    expect(falsification).not.toHaveProperty("statement");
  });

  it("rejects empty hypothesis ids", () => {
    expect(() => createFalsification("   ", CRITERION, "fals-1")).toThrow(/hypothesisId/);
  });

  it("rejects empty criteria and empty ids", () => {
    expect(() => createFalsification(HYPOTHESIS_ID, "   ", "fals-1")).toThrow(/criterion/);
    expect(() => createFalsification(HYPOTHESIS_ID, CRITERION, "  ")).toThrow(/id/);
  });

  it("is frozen according to the Phase 1 conventions", () => {
    const falsification = createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1");

    expect(Object.isFrozen(falsification)).toBe(true);
  });

  it("allows multiple criteria for the same hypothesis", () => {
    const first = createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1");
    const second = createFalsification(
      HYPOTHESIS_ID,
      "If a stale action becomes executable after generation rotation, this hypothesis is false.",
      "fals-2",
    );

    expect(first.hypothesisId).toBe(HYPOTHESIS_ID);
    expect(second.hypothesisId).toBe(HYPOTHESIS_ID);
    expect(first.id).not.toBe(second.id);
  });

  it("is not evidence and carries no verdict", () => {
    const falsification = createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1");

    expect(falsification).not.toHaveProperty("source");
    expect(falsification).not.toHaveProperty("content");
    expect(falsification).not.toHaveProperty("relation");
    expect(falsification).not.toHaveProperty("supports");
    expect(falsification).not.toHaveProperty("verdict");
    expect(falsification).not.toHaveProperty("status");
  });
});

describe("falsification within an investigation", () => {
  it("creates no status change: criterion is not a refutation", () => {
    let investigation = seedInvestigation();
    investigation = addFalsification(
      investigation,
      createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1"),
    );

    // The hypothesis was never evaluated — stating what WOULD refute it
    // changes nothing about its current standing.
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
    expect(investigation.status).toBe("unknown");
  });

  it("holds several criteria for one hypothesis in the aggregate", () => {
    let investigation = seedInvestigation();
    investigation = addFalsification(investigation, createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1"));
    investigation = addFalsification(
      investigation,
      createFalsification(
        HYPOTHESIS_ID,
        "If a stale action becomes executable after generation rotation, this hypothesis is false.",
        "fals-2",
      ),
    );

    expect(investigation.falsifications.map((f) => f.id)).toEqual(["fals-1", "fals-2"]);
    expect(investigation.status).toBe("unknown");
  });

  it("does not mutate the previous Investigation state", () => {
    const before = seedInvestigation();
    const snapshot = structuredClone(before);

    const after = addFalsification(before, createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1"));

    expect(before).toEqual(snapshot);
    expect(before.falsifications).toEqual([]);
    expect(after.falsifications).toHaveLength(1);
    expect(after).not.toBe(before);
  });

  it("starts empty and rejects duplicate falsification ids", () => {
    const investigation = seedInvestigation();

    expect(investigation.falsifications).toEqual([]);

    const withOne = addFalsification(
      investigation,
      createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1"),
    );

    expect(() =>
      addFalsification(withOne, createFalsification(HYPOTHESIS_ID, CRITERION, "fals-1")),
    ).toThrow(/Duplicate falsification id/);
  });
});
