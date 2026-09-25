import { describe, expect, it } from "vitest";
import { createGoal } from "../src/investigation/goal.js";
import { createObservation } from "../src/investigation/observation.js";
import { createEvidence, linkEvidenceToHypothesis } from "../src/investigation/evidence.js";
import { createEvaluation } from "../src/investigation/evaluation.js";
import {
  createHypothesis,
  transitionHypothesis,
} from "../src/investigation/hypothesis.js";
import { createInvariant } from "../src/investigation/invariant.js";
import type { InvestigationSource } from "../src/investigation/source.js";
import {
  addEvaluation,
  addEvidence,
  addHypothesis,
  addInvariant,
  addObservation,
  createInvestigation,
  setInvestigationStatus,
  updateEvidence,
  updateHypothesis,
} from "../src/investigation/investigation.js";

const SOURCES: InvestigationSource[] = [
  { kind: "agent-assertion", agent: "research" },
  { kind: "tool-result", tool: "test-runner" },
  { kind: "test-result", suite: "planner.test.ts" },
  { kind: "runtime-event", event: "text_delta" },
  { kind: "user-provided" },
];

describe("Goal", () => {
  it("can be represented with a stable identity and description", () => {
    const goal = createGoal("Understand why retries spike at midnight", "goal-1");

    expect(goal).toEqual({ id: "goal-1", description: "Understand why retries spike at midnight" });
  });

  it("is frozen against mutation", () => {
    const goal = createGoal("Understand the outage", "goal-1");

    expect(Object.isFrozen(goal)).toBe(true);
  });

  it("rejects empty descriptions and ids", () => {
    expect(() => createGoal("   ", "goal-1")).toThrow(/description/);
    expect(() => createGoal("Understand X", "  ")).toThrow(/id/);
  });
});

describe("Observation", () => {
  it("preserves its provenance", () => {
    const observation = createObservation(
      "The model claimed retries spike at midnight",
      { kind: "agent-assertion", agent: "research" },
      "obs-1",
    );

    expect(observation.source).toEqual({ kind: "agent-assertion", agent: "research" });
    expect(observation.content).toBe("The model claimed retries spike at midnight");
  });

  it("supports every provenance kind without becoming evidence", () => {
    for (const [index, source] of SOURCES.entries()) {
      const observation = createObservation("sighting", source, `obs-${index}`);

      expect(observation.source).toEqual(source);
      // An observation carries no hypothesis linkage: recording it
      // claims nothing about what it supports.
      expect(observation).not.toHaveProperty("hypothesisIds");
    }
  });
});

describe("Evidence", () => {
  it("preserves provenance for every source kind", () => {
    for (const [index, source] of SOURCES.entries()) {
      const evidence = createEvidence("measured retry counts", source, {
        id: `ev-${index}`,
      });

      expect(evidence.source).toEqual(source);
    }
  });

  it("distinguishes an agent assertion from verified information", () => {
    // An LLM's statement recorded as evidence is still just an
    // assertion: the source kind never confers verification, and nothing
    // about the hypothesis changes by recording it.
    const evidence = createEvidence(
      "The model said the cache is the cause",
      { kind: "agent-assertion", agent: "general" },
      { id: "ev-1", hypothesisIds: ["hyp-1"] },
    );
    const hypothesis = createHypothesis("The cache is the cause", "hyp-1");

    expect(evidence.hypothesisIds).toEqual(["hyp-1"]);
    expect(hypothesis.status).toBe("candidate");
  });

  it("links evidence to hypotheses as a relationship, not a verdict", () => {
    const evidence = createEvidence("retry counts by hour", { kind: "tool-result", tool: "metrics" }, {
      id: "ev-1",
    });

    const linked = linkEvidenceToHypothesis(linkEvidenceToHypothesis(evidence, "hyp-1"), "hyp-2");

    expect(linked.hypothesisIds).toEqual(["hyp-1", "hyp-2"]);
    // Linkage adds no verdict field to the evidence.
    expect(linked).not.toHaveProperty("verdict");
    expect(linked).not.toHaveProperty("supports");
    // The input is untouched and linking twice is a no-op.
    expect(evidence.hypothesisIds).toEqual([]);
    expect(linkEvidenceToHypothesis(linked, "hyp-1")).toBe(linked);
  });
});

describe("Hypothesis lifecycle", () => {
  it("starts every hypothesis as a candidate, even when an LLM proposed it", () => {
    const hypothesis = createHypothesis("The cache is the cause", "hyp-1");

    expect(hypothesis.status).toBe("candidate");
  });

  it("transitions candidate -> supported -> refuted without mutating the input", () => {
    const candidate = createHypothesis("The cache is the cause", "hyp-1");

    const supported = transitionHypothesis(candidate, "supported");
    const refuted = transitionHypothesis(supported, "refuted");

    expect(supported.status).toBe("supported");
    expect(refuted.status).toBe("refuted");
    // Earlier states stay representable: transitions return new objects.
    expect(candidate.status).toBe("candidate");
    expect(supported.status).toBe("supported");
    expect(refuted).not.toBe(supported);
  });

  it("allows re-evaluation out of refuted and inconclusive states", () => {
    const refuted = transitionHypothesis(createHypothesis("stale cache", "hyp-1"), "refuted");

    expect(transitionHypothesis(refuted, "supported").status).toBe("supported");
    expect(transitionHypothesis(refuted, "inconclusive").status).toBe("inconclusive");
    expect(
      transitionHypothesis(createHypothesis("dns", "hyp-2"), "inconclusive").status,
    ).toBe("inconclusive");
  });

  it("rejects returning to candidate", () => {
    const supported = transitionHypothesis(createHypothesis("cache", "hyp-1"), "supported");

    expect(() => transitionHypothesis(supported, "candidate")).toThrow(/Invalid hypothesis transition/);
  });

  it("keeps refuted hypotheses representable inside the investigation", () => {
    const goal = createGoal("Understand the outage", "goal-1");
    const refuted = transitionHypothesis(createHypothesis("The cache is the cause", "hyp-1"), "refuted");

    const investigation = updateHypothesis(
      addHypothesis(createInvestigation(goal, { id: "inv-1" }), createHypothesis("The cache is the cause", "hyp-1")),
      refuted,
    );

    expect(investigation.hypotheses).toEqual([refuted]);
    expect(investigation.hypotheses[0]?.status).toBe("refuted");
  });
});

describe("Invariant", () => {
  it("can be represented with a stable identity and statement", () => {
    const invariant = createInvariant("Every settled result carries a distinct id", "inv-rule-1");

    expect(invariant).toEqual({
      id: "inv-rule-1",
      statement: "Every settled result carries a distinct id",
    });
    expect(Object.isFrozen(invariant)).toBe(true);
  });
});

describe("Investigation", () => {
  function seedInvestigation(id = "inv-1") {
    const goal = createGoal("Understand the outage", "goal-1");
    return createInvestigation(goal, { id });
  }

  it("exists in an unknown state by default", () => {
    const investigation = seedInvestigation();

    expect(investigation.status).toBe("unknown");
    expect(investigation.observations).toEqual([]);
    expect(investigation.hypotheses).toEqual([]);
    expect(investigation.evidence).toEqual([]);
    expect(investigation.invariants).toEqual([]);
  });

  it("sets its outcome explicitly instead of inferring it", () => {
    const investigation = seedInvestigation();

    expect(setInvestigationStatus(investigation, "succeeded").status).toBe("succeeded");
    expect(setInvestigationStatus(investigation, "failed").status).toBe("failed");
    // The input snapshot is untouched.
    expect(investigation.status).toBe("unknown");
  });

  it("contains observations, hypotheses, evidence, and invariants", () => {
    let investigation = seedInvestigation();
    investigation = addObservation(
      investigation,
      createObservation("spike at midnight", { kind: "tool-result", tool: "metrics" }, "obs-1"),
    );
    investigation = addHypothesis(
      investigation,
      createHypothesis("A cron job clears the cache", "hyp-1"),
    );
    investigation = addEvidence(
      investigation,
      createEvidence("cron table", { kind: "tool-result", tool: "crontab" }, { id: "ev-1" }),
    );
    investigation = addInvariant(
      investigation,
      createInvariant("Retries never exceed the configured budget", "rule-1"),
    );

    expect(investigation.observations.map((o) => o.id)).toEqual(["obs-1"]);
    expect(investigation.hypotheses.map((h) => h.id)).toEqual(["hyp-1"]);
    expect(investigation.evidence.map((e) => e.id)).toEqual(["ev-1"]);
    expect(investigation.invariants.map((i) => i.id)).toEqual(["rule-1"]);
    expect(investigation.goal).toEqual({ id: "goal-1", description: "Understand the outage" });
  });

  it("publishes evidence linkage back into the aggregate without a verdict", () => {
    let investigation = addEvidence(
      addHypothesis(seedInvestigation(), createHypothesis("cron clears the cache", "hyp-1")),
      createEvidence("cron table", { kind: "tool-result", tool: "crontab" }, { id: "ev-1" }),
    );

    const linked = linkEvidenceToHypothesis(investigation.evidence[0]!, "hyp-1");
    investigation = updateEvidence(investigation, linked);

    expect(investigation.evidence[0]?.hypothesisIds).toEqual(["hyp-1"]);
    // Publishing linkage evaluates nothing.
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
    expect(investigation.status).toBe("unknown");
  });

  it("rejects duplicate member ids", () => {
    const investigation = addObservation(
      seedInvestigation(),
      createObservation("first", { kind: "user-provided" }, "obs-1"),
    );

    expect(() =>
      addObservation(investigation, createObservation("second", { kind: "user-provided" }, "obs-1")),
    ).toThrow(/Duplicate observation id/);
  });
});

describe("addEvaluation", () => {
  function seedInvestigation(id = "inv-1") {
    const goal = createGoal("Understand the outage", "goal-1");
    return createInvestigation(goal, { id });
  }

  function evaluation(id = "eval-1", evidenceId = "ev-1", hypothesisId = "hyp-1") {
    return createEvaluation(evidenceId, hypothesisId, "supports", "Directly observed.", id);
  }

  it("appends evaluations in application order without touching standing", () => {
    let investigation = seedInvestigation();
    investigation = addEvaluation(investigation, evaluation("eval-1"));
    investigation = addEvaluation(
      investigation,
      createEvaluation("ev-1", "hyp-2", "inconclusive", "Says nothing about hyp-2.", "eval-2"),
    );

    expect(investigation.evaluations.map((e) => e.id)).toEqual(["eval-1", "eval-2"]);
    // Appending records grounds; only applyEvaluation moves standing.
    expect(investigation.hypotheses).toEqual([]);
    expect(investigation.status).toBe("unknown");
  });

  it("rejects a second evaluation of the same pair but allows new pairs", () => {
    const investigation = addEvaluation(seedInvestigation(), evaluation("eval-1"));

    // Same pair, different record id: still one question, still rejected.
    expect(() => addEvaluation(investigation, evaluation("eval-2"))).toThrow(
      /Duplicate evaluation for evidence/,
    );
    // Same evidence against another hypothesis is an independent pair.
    expect(() =>
      addEvaluation(investigation, createEvaluation("ev-1", "hyp-2", "supports", "Why.", "eval-3")),
    ).not.toThrow();
  });

  it("rejects duplicate pairs supplied at construction", () => {
    expect(() =>
      createInvestigation(createGoal("Understand the outage", "goal-1"), {
        id: "inv-1",
        evaluations: [evaluation("eval-1"), evaluation("eval-2")],
      }),
    ).toThrow(/Duplicate evaluation for evidence/);
  });

  it("does not mutate the previous snapshot", () => {
    const before = seedInvestigation();
    const snapshot = structuredClone(before);

    const after = addEvaluation(before, evaluation());

    expect(before).toEqual(snapshot);
    expect(before.evaluations).toEqual([]);
    expect(after.evaluations).toHaveLength(1);
    expect(after).not.toBe(before);
    expect(Object.isFrozen(after.evaluations)).toBe(true);
  });
});
