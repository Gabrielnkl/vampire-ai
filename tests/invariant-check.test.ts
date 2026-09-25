import { describe, expect, it } from "vitest";
import { createEvidence } from "../src/investigation/evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import { createInvariant } from "../src/investigation/invariant.js";
import { createInvariantCheck } from "../src/investigation/invariant-check.js";
import {
  addEvidence,
  addHypothesis,
  addInvariant,
  addInvariantCheck,
  createInvestigation,
} from "../src/investigation/investigation.js";

const INVARIANT_ID = "rule-1";
const STATEMENT = "A logical action identified by (nodeId, idempotencyKey) has at most one live pending owner.";

function seedInvestigation(id = "inv-1") {
  const goal = createGoal("Understand stale execution", "goal-1");
  let investigation = addInvariant(
    createInvestigation(goal, { id }),
    createInvariant(STATEMENT, INVARIANT_ID),
  );
  investigation = addEvidence(
    investigation,
    createEvidence("one pending action for (n1, k1)", { kind: "tool-result", tool: "queue-probe" }, { id: "ev-1" }),
  );
  investigation = addEvidence(
    investigation,
    createEvidence("two pending actions for (n1, k1)", { kind: "tool-result", tool: "queue-probe" }, { id: "ev-2" }),
  );
  return addHypothesis(
    investigation,
    createHypothesis("pairingGeneration prevents stale accepted actions from executing.", "hyp-1"),
  );
}

describe("InvariantCheck", () => {
  it("creates a check referencing its invariant and evidence by ID", () => {
    const check = createInvariantCheck(
      INVARIANT_ID,
      ["ev-1"],
      "holds",
      "Exactly one pending action was observed for the logical action.",
      "check-1",
    );

    expect(check).toEqual({
      id: "check-1",
      invariantId: INVARIANT_ID,
      evidenceIds: ["ev-1"],
      result: "holds",
      reasoning: "Exactly one pending action was observed for the logical action.",
    });
    expect(check).not.toHaveProperty("invariant");
    expect(check).not.toHaveProperty("evidence");
  });

  it.each([["holds"], ["violated"], ["unknown"]] as const)(
    "represents the %s result",
    (result) => {
      const check = createInvariantCheck(INVARIANT_ID, ["ev-1"], result, "Considered the cited evidence.", `check-${result}`);

      expect(check.result).toBe(result);
    },
  );

  it("rejects empty invariant ids", () => {
    expect(() => createInvariantCheck("   ", ["ev-1"], "holds", "Why.", "check-1")).toThrow(
      /invariantId/,
    );
  });

  it("rejects missing or empty evidence ids", () => {
    expect(() => createInvariantCheck(INVARIANT_ID, [], "unknown", "No evidence cited.", "check-1")).toThrow(
      /at least one evidence id/,
    );
    expect(() => createInvariantCheck(INVARIANT_ID, ["  "], "holds", "Why.", "check-1")).toThrow(
      /evidenceIds/,
    );
  });

  it("rejects invalid results, empty reasoning, and empty ids", () => {
    expect(() =>
      createInvariantCheck(INVARIANT_ID, ["ev-1"], "partially" as "holds", "Why.", "check-1"),
    ).toThrow(/Invalid invariant check result/);
    expect(() => createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "   ", "check-1")).toThrow(
      /reasoning/,
    );
    expect(() => createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "Why.", "  ")).toThrow(
      /id/,
    );
  });

  it("is frozen according to the Phase 1 conventions", () => {
    const check = createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "Exactly one pending action.", "check-1");

    expect(Object.isFrozen(check)).toBe(true);
    expect(Object.isFrozen(check.evidenceIds)).toBe(true);
  });

  it("allows multiple checks of the same invariant with divergent results", () => {
    // The invariant never changes; repeated checking stays representable.
    const first = createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "One pending action observed.", "check-1");
    const second = createInvariantCheck(INVARIANT_ID, ["ev-2"], "violated", "Two pending actions observed.", "check-2");

    expect(first.invariantId).toBe(INVARIANT_ID);
    expect(second.invariantId).toBe(INVARIANT_ID);
    expect(first.result).toBe("holds");
    expect(second.result).toBe("violated");
  });

  it("leaves the invariant itself without any holds/violated status", () => {
    createInvariantCheck(INVARIANT_ID, ["ev-2"], "violated", "Two pending actions observed.", "check-1");
    const invariant = createInvariant(STATEMENT, INVARIANT_ID);

    expect(invariant).toEqual({ id: INVARIANT_ID, statement: STATEMENT });
    expect(invariant).not.toHaveProperty("result");
    expect(invariant).not.toHaveProperty("holds");
    expect(invariant).not.toHaveProperty("violated");
  });

  it("does not modify the invariant or the evidence", () => {
    const invariant = createInvariant(STATEMENT, INVARIANT_ID);
    const evidence = createEvidence("two pending actions", { kind: "tool-result", tool: "queue-probe" }, { id: "ev-2" });
    const invariantSnapshot = structuredClone(invariant);
    const evidenceSnapshot = structuredClone(evidence);

    createInvariantCheck(invariant.id, [evidence.id], "violated", "Two pending actions observed.", "check-1");

    expect(invariant).toEqual(invariantSnapshot);
    expect(evidence).toEqual(evidenceSnapshot);
  });
});

describe("invariant checks within an investigation", () => {
  it("changes no hypothesis standing and no investigation status", () => {
    let investigation = seedInvestigation();
    investigation = addInvariantCheck(
      investigation,
      createInvariantCheck(INVARIANT_ID, ["ev-2"], "violated", "Two pending actions observed.", "check-1"),
    );

    // A violated required property is evidence about the system — not a
    // causal explanation, so nothing is refuted and nothing fails.
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
    expect(investigation.status).toBe("unknown");
  });

  it("contains multiple checks and starts empty", () => {
    expect(seedInvestigation().invariantChecks).toEqual([]);

    let investigation = seedInvestigation();
    investigation = addInvariantCheck(
      investigation,
      createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "One pending action observed.", "check-1"),
    );
    investigation = addInvariantCheck(
      investigation,
      createInvariantCheck(INVARIANT_ID, ["ev-2"], "violated", "Two pending actions observed.", "check-2"),
    );

    expect(investigation.invariantChecks.map((c) => c.id)).toEqual(["check-1", "check-2"]);
    expect(investigation.invariantChecks.map((c) => c.result)).toEqual(["holds", "violated"]);
    expect(investigation.status).toBe("unknown");
  });

  it("does not mutate the previous Investigation snapshot", () => {
    const before = seedInvestigation();
    const snapshot = structuredClone(before);

    const after = addInvariantCheck(
      before,
      createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "One pending action observed.", "check-1"),
    );

    expect(before).toEqual(snapshot);
    expect(before.invariantChecks).toEqual([]);
    expect(after.invariantChecks).toHaveLength(1);
    expect(after).not.toBe(before);
  });

  it("rejects duplicate check ids", () => {
    const investigation = addInvariantCheck(
      seedInvestigation(),
      createInvariantCheck(INVARIANT_ID, ["ev-1"], "holds", "One pending action observed.", "check-1"),
    );

    expect(() =>
      addInvariantCheck(
        investigation,
        createInvariantCheck(INVARIANT_ID, ["ev-2"], "violated", "Two pending actions observed.", "check-1"),
      ),
    ).toThrow(/Duplicate invariantCheck id/);
  });
});
