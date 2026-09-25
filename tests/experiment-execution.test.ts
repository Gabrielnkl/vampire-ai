import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExperimentExecutor } from "../src/agents/experiment-executor.js";
import { createExperimentExecution } from "../src/agents/experiment-execution.js";
import { observationToEvidence } from "../src/agents/observation-evidence.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createExperiment } from "../src/investigation/experiment.js";
import type { Experiment } from "../src/investigation/experiment.js";
import { createFalsification } from "../src/investigation/falsification.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvidence,
  addExperiment,
  addExperimentExecution,
  addFalsification,
  addHypothesis,
  addObservation,
  createInvestigation,
} from "../src/investigation/investigation.js";
import { createObservation } from "../src/investigation/observation.js";
import type { Observation } from "../src/investigation/observation.js";

const HYPOTHESIS_ID = "hyp-1";
const FALSIFICATION_ID = "fals-1";
const EXPERIMENT_ID = "exp-1";

/**
 * Local deterministic fake: stands in for a real registry-fence
 * harness. Performs no I/O, touches no network, model, or clock —
 * it returns the observation its capability would have produced.
 * NOT shipped as production code.
 */
class RegistryFenceExecutor implements ExperimentExecutor {
  calls: Experiment[] = [];

  async execute(experiment: Experiment): Promise<Observation> {
    this.calls.push(experiment);
    return createObservation(
      "registry rejected stale snapshot",
      { kind: "test-result", suite: "registry-fence" },
      "obs-1",
    );
  }
}

function seedInvestigation(id = "inv-1") {
  const goal = createGoal("Determine why a task occasionally resurrects after shutdown.", "goal-1");
  let investigation = addHypothesis(
    createInvestigation(goal, { id }),
    createHypothesis("A stale snapshot can reintroduce a previously completed task.", HYPOTHESIS_ID),
  );
  investigation = addFalsification(
    investigation,
    createFalsification(
      HYPOTHESIS_ID,
      "If the registry rejects the stale snapshot under the generation fence, H1 is contradicted.",
      FALSIFICATION_ID,
    ),
  );
  return addExperiment(
    investigation,
    createExperiment(
      HYPOTHESIS_ID,
      "Submit the stale snapshot to the registry under the current generation fence and record whether it is accepted or rejected.",
      { falsificationId: FALSIFICATION_ID, id: EXPERIMENT_ID },
    ),
  );
}

describe("experiment execution boundary end to end", () => {
  it("turns a plan into retained evidence with answerable lineage", async () => {
    const executor = new RegistryFenceExecutor();
    let investigation = seedInvestigation();
    const experiment = investigation.experiments[0]!;

    const observation = await executor.execute(experiment);
    expect(observation).toEqual({
      id: "obs-1",
      content: "registry rejected stale snapshot",
      source: { kind: "test-result", suite: "registry-fence" },
    });

    const execution = createExperimentExecution(experiment, observation, "exec-1");
    expect(execution).toEqual({ id: "exec-1", experimentId: EXPERIMENT_ID, observationId: "obs-1" });
    expect(Object.isFrozen(execution)).toBe(true);

    investigation = addObservation(investigation, observation);
    investigation = addExperimentExecution(investigation, execution);
    const evidence = observationToEvidence(observation, { id: "ev-1" });
    investigation = addEvidence(investigation, evidence);

    // Final state contains plan, lineage, and retained evidence.
    expect(investigation.experiments.map((e) => e.id)).toEqual([EXPERIMENT_ID]);
    expect(investigation.experimentExecutions).toEqual([execution]);
    expect(investigation.evidence.map((e) => e.id)).toEqual(["ev-1"]);
    // Lineage is answerable end to end without embedding objects.
    const stored = investigation.experimentExecutions[0]!;
    expect(stored.experimentId).toBe(EXPERIMENT_ID);
    expect(stored.observationId).toBe("obs-1");
    expect(investigation.evidence[0]).toEqual({
      id: "ev-1",
      content: "registry rejected stale snapshot",
      source: { kind: "test-result", suite: "registry-fence" },
      hypothesisIds: [],
    });
    expect(executor.calls).toHaveLength(1);
  });

  it("executes only on explicit calls, never from constructors or aggregation", async () => {
    const executor = new RegistryFenceExecutor();

    createExperiment(HYPOTHESIS_ID, "Do something.", { id: "exp-9" });
    createObservation("saw something", { kind: "user-provided" }, "obs-9");
    const observation = createObservation("saw more", { kind: "user-provided" }, "obs-8");
    observationToEvidence(observation, { id: "ev-9" });
    addEvidence(seedInvestigation(), createEvidence("kept", { kind: "user-provided" }, { id: "ev-8" }));

    expect(executor.calls).toHaveLength(0);
  });
});

describe("provenance discipline", () => {
  it("preserves test-result provenance unchanged through promotion", async () => {
    const observation = await new RegistryFenceExecutor().execute(
      createExperiment(HYPOTHESIS_ID, "Do something.", { id: EXPERIMENT_ID }),
    );

    const evidence = observationToEvidence(observation, { id: "ev-1" });

    expect(evidence.source).toEqual({ kind: "test-result", suite: "registry-fence" });
    expect(evidence.source).not.toEqual({ kind: "agent-assertion", agent: expect.anything() });
  });

  it("never converts agent-assertion into test-result or vice versa", () => {
    const asserted = createObservation("the model claims a rejection", { kind: "agent-assertion", agent: "general" }, "obs-a");
    const tested = createObservation("registry rejected stale snapshot", { kind: "test-result", suite: "registry-fence" }, "obs-t");

    expect(observationToEvidence(asserted, { id: "ev-a" }).source).toEqual({
      kind: "agent-assertion",
      agent: "general",
    });
    expect(observationToEvidence(tested, { id: "ev-t" }).source).toEqual({
      kind: "test-result",
      suite: "registry-fence",
    });
  });

  it("rejects empty execution ids and duplicate lineage entries", async () => {
    const experiment = createExperiment(HYPOTHESIS_ID, "Do something.", { id: EXPERIMENT_ID });
    const observation = await new RegistryFenceExecutor().execute(experiment);

    expect(() => createExperimentExecution(experiment, observation, "  ")).toThrow(/id/);

    const investigation = addExperimentExecution(
      seedInvestigation(),
      createExperimentExecution(experiment, observation, "exec-1"),
    );
    expect(() =>
      addExperimentExecution(investigation, createExperimentExecution(experiment, observation, "exec-1")),
    ).toThrow(/Duplicate experimentExecution id/);
  });
});

describe("epistemic and snapshot guarantees", () => {
  it("changes no standing or status through execution, lineage, or promotion", async () => {
    const executor = new RegistryFenceExecutor();
    let investigation = seedInvestigation();
    const experiment = investigation.experiments[0]!;

    const observation = await executor.execute(experiment);
    investigation = addObservation(investigation, observation);
    investigation = addExperimentExecution(
      investigation,
      createExperimentExecution(experiment, observation, "exec-1"),
    );
    investigation = addEvidence(investigation, observationToEvidence(observation, { id: "ev-1" }));

    // A rejection was observed and retained — yet H1 is still candidate:
    // only an explicit applyEvaluation() may move it.
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
    expect(investigation.status).toBe("unknown");
    expect(investigation.evidence[0]?.hypothesisIds).toEqual([]);
  });

  it("keeps every prior snapshot and member unchanged", async () => {
    const executor = new RegistryFenceExecutor();
    const before = seedInvestigation();
    const snapshot = structuredClone(before);
    const experiment = before.experiments[0]!;
    const experimentSnapshot = structuredClone(experiment);

    const observation = await executor.execute(experiment);
    const afterObservation = addObservation(before, observation);
    const afterExecution = addExperimentExecution(
      afterObservation,
      createExperimentExecution(experiment, observation, "exec-1"),
    );
    const afterEvidence = addEvidence(afterExecution, observationToEvidence(observation, { id: "ev-1" }));

    expect(before).toEqual(snapshot);
    expect(experiment).toEqual(experimentSnapshot);
    expect(afterObservation).not.toBe(before);
    expect(afterExecution).not.toBe(afterObservation);
    expect(afterEvidence).not.toBe(afterExecution);
    expect(afterEvidence.experimentExecutions).toHaveLength(1);
  });

  it("proves plan, observation, and evidence are three separate things", async () => {
    const experiment = createExperiment(
      HYPOTHESIS_ID,
      "Submit the stale snapshot to the registry under the current generation fence and record whether it is accepted or rejected.",
      { falsificationId: FALSIFICATION_ID, id: EXPERIMENT_ID },
    );
    const observation = await new RegistryFenceExecutor().execute(experiment);
    const evidence = observationToEvidence(observation, { id: "ev-1" });

    expect(experiment.procedure).not.toBe(observation.content);
    expect(observation.content).toBe(evidence.content);
    expect(experiment).not.toHaveProperty("status");
    expect(observation).not.toHaveProperty("hypothesisIds");
    expect(evidence).not.toHaveProperty("relation");
  });

  it("uses no Agent runtime in the executor boundary", async () => {
    const executorFiles = [
      new URL("../src/agents/experiment-executor.ts", import.meta.url),
      new URL("../src/agents/experiment-execution.ts", import.meta.url),
      new URL("../src/agents/observation-evidence.ts", import.meta.url),
    ];
    for (const file of executorFiles) {
      const raw = readFileSync(file, "utf8");
      // Prose about the boundary is not use of it: strip comments so
      // doc mentions of `Agent.run()` cannot satisfy or fail the check.
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
      expect(source).not.toContain(".run(");
      expect(source).not.toMatch(/from ["']\.\/(agent|single-agent|multi-agent|planner|llm-)/);
      expect(source).not.toMatch(/from ["']\.\.\/llm\//);
      expect(source).not.toMatch(/from ["'](openai|ink|react)["']/);
    }
    const module = await import("../src/agents/observation-evidence.js");
    expect(Object.keys(module).sort()).toEqual(["observationToEvidence"]);
    const recordModule = await import("../src/agents/experiment-execution.js");
    expect(Object.keys(recordModule).sort()).toEqual(["createExperimentExecution"]);
  });
});
