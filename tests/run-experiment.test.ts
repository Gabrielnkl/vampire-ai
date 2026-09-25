import { describe, expect, it } from "vitest";
import { runExperimentStep, runInvestigationStep } from "../src/agents/investigation-step.js";
import { investigationActionToRequest } from "../src/agents/action-request.js";
import { runInvestigationLoop } from "../src/agents/investigation-loop.js";
import { createExperimentExecution } from "../src/agents/experiment-execution.js";
import { HttpStatusExperimentExecutor } from "../src/agents/http-status-executor.js";
import type { Agent, AgentRun } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { AgentEvent } from "../src/agents/events.js";
import { freezeResult } from "../src/agents/result.js";
import type { ExperimentExecutor } from "../src/agents/experiment-executor.js";
import type { Experiment } from "../src/investigation/experiment.js";
import { createExperiment } from "../src/investigation/experiment.js";
import type { InvestigationSource } from "../src/investigation/source.js";
import { createObservation } from "../src/investigation/observation.js";
import type { Observation } from "../src/investigation/observation.js";
import {
  createRunExperimentAction,
  decideNextInvestigationAction,
} from "../src/investigation/action.js";
import { createFalsification } from "../src/investigation/falsification.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import { transitionHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvaluation,
  addEvidence,
  addExperiment,
  addExperimentExecution,
  addFalsification,
  addHypothesis,
  createInvestigation,
  setInvestigationStatus,
  updateHypothesis,
} from "../src/investigation/investigation.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createEvaluation } from "../src/investigation/evaluation.js";

const HYPOTHESIS_ID = "hyp-1";
const FALSIFICATION_ID = "fals-1";
const PROCEDURE =
  "Submit the stale snapshot to the registry under the current generation fence and record whether it is accepted or rejected.";

/** Proves Agent.run is never involved: any call fails the test. */
class NeverRuns implements Agent {
  readonly descriptor = { name: "never", description: "Must never run." };

  run(_input: string, _context: AgentContext): AgentRun {
    throw new Error("Agent.run must not be called");
  }
}

/** Local deterministic fake executor. NOT shipped as production code. */
class RegistryFenceExecutor implements ExperimentExecutor {
  calls: Experiment[] = [];
  constructor(
    private readonly content = "registry rejected stale snapshot",
    private readonly source: InvestigationSource = { kind: "test-result", suite: "registry-fence" },
    private readonly observationId = "obs-1",
  ) {}

  async execute(experiment: Experiment) {
    this.calls.push(experiment);
    return createObservation(this.content, this.source, this.observationId);
  }
}

class FailingExecutor implements ExperimentExecutor {
  async execute(): Promise<Observation> {
    throw new Error("harness down");
  }
}

/** Deterministic agent deriving its proposal from the request prompt. */
class CitingAgent implements Agent {
  readonly descriptor = { name: "citer", description: "Cites prompt evidence." };
  calls = 0;
  constructor(
    private readonly hypothesisId: string,
    private readonly relation: "supports" | "contradicts" | "inconclusive",
  ) {}

  run(input: string, _context: AgentContext): AgentRun {
    this.calls += 1;
    // The request prompt names exactly one pair as `Evidence (<id>):`;
    // cite it back so the proposal always addresses real snapshot state.
    const evidenceId = input.match(/Evidence \(([^)]+)\):/)?.[1] ?? "missing";
    const text = [
      `Evidence: ${evidenceId}`,
      `Hypothesis: ${this.hypothesisId}`,
      `Relation: ${this.relation}`,
      `Reasoning: cited from the request prompt.`,
    ].join("\n");
    const result = freezeResult(`exec-cite-${this.calls}`, "citer", [
      { role: "assistant", content: text },
    ]);
    return {
      events: (async function* (): AsyncGenerator<AgentEvent> {})(),
      result: Promise.resolve(result),
    };
  }
}

function seedExperimentInvestigation(id = "inv-1") {
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
    createExperiment(HYPOTHESIS_ID, PROCEDURE, { falsificationId: FALSIFICATION_ID, id: "exp-1" }),
  );
}

describe("decideNextInvestigationAction: run-experiment", () => {
  it("requests the eligible experiment when no evidence exists", () => {
    const action = decideNextInvestigationAction(seedExperimentInvestigation(), { id: "act-1" });

    expect(action).toEqual({ id: "act-1", kind: "run-experiment", experimentId: "exp-1" });
  });

  it("selects the first eligible experiment deterministically", () => {
    let investigation = seedExperimentInvestigation();
    investigation = addExperiment(
      investigation,
      createExperiment(HYPOTHESIS_ID, "Replay the shutdown sequence.", { id: "exp-2" }),
    );

    const first = decideNextInvestigationAction(investigation, { id: "act-1" });
    const second = decideNextInvestigationAction(investigation, { id: "act-1" });

    expect(first).toEqual({ id: "act-1", kind: "run-experiment", experimentId: "exp-1" });
    expect(second).toEqual(first);
  });

  it("skips already-executed experiments", () => {
    const before = seedExperimentInvestigation();
    const observation = createObservation("rejected", { kind: "test-result", suite: "registry-fence" }, "obs-0");
    const investigation = addExperimentExecution(
      before,
      createExperimentExecution(before.experiments[0]!, observation, "exec-0"),
    );

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "undetermined",
    });
  });

  it("keeps experiments eligible regardless of hypothesis standing", () => {
    // Standing is epistemic state, not work permission: supported,
    // refuted, and inconclusive targets stay eligible. Each standing
    // gets the same unexecuted experiment and the same decision.
    for (const standing of ["supported", "refuted", "inconclusive"] as const) {
      const before = seedExperimentInvestigation(`inv-${standing}`);
      const investigation = updateHypothesis(
        before,
        transitionHypothesis(before.hypotheses[0]!, standing),
      );

      expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
        id: "act-1",
        kind: "run-experiment",
        experimentId: "exp-1",
      });
    }
  });

  it("selects by experiment insertion order, not hypothesis order", () => {
    // H1 is supported while H2 is candidate, and X1 (→ H1) was stored
    // before X2 (→ H2): standing-blind insertion order selects X1.
    let investigation = addHypothesis(
      createInvestigation(createGoal("Determine why a task occasionally resurrects after shutdown.", "goal-1"), { id: "inv-order" }),
      createHypothesis("A stale snapshot can reintroduce a previously completed task.", "hyp-1"),
    );
    investigation = updateHypothesis(
      investigation,
      transitionHypothesis(investigation.hypotheses[0]!, "supported"),
    );
    investigation = addHypothesis(
      investigation,
      createHypothesis("Shutdown races with task completion.", "hyp-2"),
    );
    investigation = addExperiment(
      investigation,
      createExperiment("hyp-1", "Probe the supported hypothesis.", { id: "exp-1" }),
    );
    investigation = addExperiment(
      investigation,
      createExperiment("hyp-2", "Probe the candidate hypothesis.", { id: "exp-2" }),
    );

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "run-experiment",
      experimentId: "exp-1",
    });
  });

  it("skips experiments whose target hypothesis no longer exists", () => {
    let investigation = seedExperimentInvestigation();
    investigation = addExperiment(
      investigation,
      createExperiment("hyp-missing", "Probe nothing.", { id: "exp-dangling" }),
    );

    // exp-1 (existing target) still wins; the dangling experiment is
    // skipped without error at decision time.
    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "run-experiment",
      experimentId: "exp-1",
    });
  });

  it("keeps falsification-free experiments eligible", () => {
    let investigation = seedExperimentInvestigation();
    investigation = addExperiment(
      investigation,
      createExperiment(HYPOTHESIS_ID, "Watch the registry during shutdown.", { id: "exp-9" }),
    );

    // exp-1 (linked) still wins by insertion order; exp-9 stays eligible.
    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "run-experiment",
      experimentId: "exp-1",
    });
  });

  it("lets existing evidence keep evaluate-hypothesis winning", () => {
    // Rule 2 predicate unchanged: candidate + any evidence → evaluate,
    // even with an eligible experiment waiting.
    const investigation = addEvidence(
      seedExperimentInvestigation(),
      createEvidence("prior log line", { kind: "tool-result", tool: "log-reader" }, { id: "ev-0" }),
    );

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "evaluate-hypothesis",
      hypothesisId: HYPOTHESIS_ID,
      evidenceId: "ev-0",
    });
  });

  it("returns undetermined with no eligible experiment and no evidence", () => {
    const investigation = createInvestigation(createGoal("Understand stale execution", "goal-1"), {
      id: "inv-empty",
    });

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "undetermined",
    });
  });

  it("returns finish on explicit status despite eligible experiments", () => {
    const investigation = setInvestigationStatus(seedExperimentInvestigation(), "failed");

    expect(decideNextInvestigationAction(investigation, { id: "act-1" })).toEqual({
      id: "act-1",
      kind: "finish",
    });
  });
  it("requests no Agent.run() work for experiment actions", () => {
    expect(
      investigationActionToRequest(createRunExperimentAction("exp-1", "act-1"), seedExperimentInvestigation()),
    ).toBeNull();
  });
});

describe("runInvestigationStep: run-experiment", () => {
  const stepIds = { actionId: "act-1", evidenceId: "ev-1", experimentExecutionId: "exec-1" };

  async function experimentStep() {
    const executor = new RegistryFenceExecutor();
    const investigation = seedExperimentInvestigation();
    const result = await runInvestigationStep(investigation, new NeverRuns(), {
      ...stepIds,
      executor,
    });
    if (result.kind !== "experiment-executed") {
      throw new Error(`expected experiment-executed, got ${result.kind}`);
    }
    return { result, executor, before: investigation };
  }

  it("calls the injected executor exactly once, never Agent.run", async () => {
    const { result, executor, before } = await experimentStep();

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toEqual(before.experiments[0]);
    expect(result.action).toEqual({ id: "act-1", kind: "run-experiment", experimentId: "exp-1" });
  });

  it("records observation, lineage, and verdict-free evidence", async () => {
    const { result } = await experimentStep();

    expect(result.observation).toEqual({
      id: "obs-1",
      content: "registry rejected stale snapshot",
      source: { kind: "test-result", suite: "registry-fence" },
    });
    expect(result.experimentExecution).toEqual({
      id: "exec-1",
      experimentId: "exp-1",
      observationId: "obs-1",
    });
    expect(result.evidence).toEqual({
      id: "ev-1",
      content: "registry rejected stale snapshot",
      source: { kind: "test-result", suite: "registry-fence" },
      hypothesisIds: [],
    });
    expect(result.investigation.observations.map((o) => o.id)).toEqual(["obs-1"]);
    expect(result.investigation.experimentExecutions).toEqual([result.experimentExecution]);
    expect(result.investigation.evidence.map((e) => e.id)).toEqual(["ev-1"]);
  });

  it("performs no evaluation and changes no standing or status", async () => {
    const { result, before } = await experimentStep();

    expect(result.investigation.hypotheses[0]?.status).toBe("candidate");
    expect(result.investigation.status).toBe("unknown");
    expect(result).not.toHaveProperty("evaluation");
    expect(before.hypotheses[0]?.status).toBe("candidate");
    expect(result.investigation).not.toBe(before);
  });

  it("records nothing on executor failure without retrying", async () => {
    const investigation = seedExperimentInvestigation();

    const result = await runInvestigationStep(investigation, new NeverRuns(), {
      actionId: "act-1",
      executor: new FailingExecutor(),
    });

    expect(result.kind).toBe("step-failed");
    if (result.kind !== "step-failed") throw new Error("unreachable");
    expect(result.failure).toBe("execution-failed");
    expect(result.detail).toContain("harness down");
    expect(result.agentResult).toBeNull();
    expect(result.evidence).toBeNull();
    expect(result.record).toBeNull();
    expect(result.investigation).toBe(investigation);
    expect(result.investigation.status).toBe("unknown");
  });

  it("turns a hung HTTP executor timeout into execution-failed without recording", async () => {
    const hangingFetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;
    const executor = new HttpStatusExperimentExecutor({
      url: "https://auth.example.test/health",
      fetchImpl: hangingFetch,
      timeoutMs: 30,
    });
    const investigation = seedExperimentInvestigation();

    // Timeout rejection flows through the existing failure taxonomy:
    // no new failure kind, no record, no retry, input untouched.
    const result = await runInvestigationStep(investigation, new NeverRuns(), {
      actionId: "act-1",
      executor,
    });

    expect(result.kind).toBe("step-failed");
    if (result.kind !== "step-failed") throw new Error("unreachable");
    expect(result.failure).toBe("execution-failed");
    // Native timeout message, unwrapped: sufficient for the existing
    // failure path, so no capability-level rewriting was added.
    expect(result.detail).toContain("aborted due to timeout");
    expect(result.evidence).toBeNull();
    expect(result.record).toBeNull();
    expect(result.investigation).toBe(investigation);
    expect(result.investigation.status).toBe("unknown");
  });

  it("refuses an already-executed experiment without calling the executor", async () => {
    const executor = new RegistryFenceExecutor();
    const before = seedExperimentInvestigation();
    const action = createRunExperimentAction("exp-1", "act-1");
    const executed = addExperimentExecution(
      before,
      createExperimentExecution(
        before.experiments[0]!,
        createObservation("rejected", { kind: "test-result", suite: "registry-fence" }, "obs-0"),
        "exec-0",
      ),
    );

    await expect(runExperimentStep(executed, action, executor, {})).rejects.toThrow(/already been executed/);
    expect(executor.calls).toHaveLength(0);
  });

  it("executes against settled standings without changing them", async () => {
    // Standing-blind execution: the same experiment runs the same way
    // against supported, refuted, and inconclusive targets, producing
    // observation and evidence while leaving standing untouched.
    for (const standing of ["supported", "refuted", "inconclusive"] as const) {
      const executor = new RegistryFenceExecutor(
        "registry rejected stale snapshot",
        { kind: "test-result", suite: "registry-fence" },
        `obs-${standing}`,
      );
      const before = seedExperimentInvestigation(`inv-${standing}`);
      const settled = updateHypothesis(
        before,
        transitionHypothesis(before.hypotheses[0]!, standing),
      );

      const result = await runExperimentStep(settled, createRunExperimentAction("exp-1", "act-1"), executor, {
        evidenceId: `ev-${standing}`,
        experimentExecutionId: `exec-${standing}`,
      });
      if (result.kind !== "experiment-executed") throw new Error(`expected experiment-executed, got ${result.kind}`);

      expect(executor.calls).toHaveLength(1);
      expect(result.investigation.hypotheses[0]?.status).toBe(standing);
      expect(result.investigation.status).toBe("unknown");
      expect(result.investigation.evidence.map((e) => e.id)).toEqual([`ev-${standing}`]);
      expect(result).not.toHaveProperty("evaluation");
    }
  });

  it("refuses a missing target hypothesis without calling the executor", async () => {
    const executor = new RegistryFenceExecutor();
    const dangling = addExperiment(
      seedExperimentInvestigation(),
      createExperiment("hyp-missing", "Probe nothing.", { id: "exp-dangling" }),
    );

    await expect(
      runExperimentStep(dangling, createRunExperimentAction("exp-dangling", "act-1"), executor, {}),
    ).rejects.toThrow(/Unknown hypothesis id/);
    expect(executor.calls).toHaveLength(0);
  });

  it("fails unknown experiment IDs consistently with existing conventions", async () => {
    const executor = new RegistryFenceExecutor();

    await expect(
      runExperimentStep(seedExperimentInvestigation(), createRunExperimentAction("exp-missing", "act-1"), executor, {}),
    ).rejects.toThrow(/Unknown experiment id/);
    expect(executor.calls).toHaveLength(0);
  });

  it("requires an injected executor instead of constructing one", async () => {
    await expect(
      runInvestigationStep(seedExperimentInvestigation(), new NeverRuns(), { actionId: "act-1" }),
    ).rejects.toThrow(/requires an ExperimentExecutor/);
  });
});

describe("runInvestigationLoop: experiment then evaluate", () => {
  it("executes the experiment first and evaluates its evidence next", async () => {
    const executor = new RegistryFenceExecutor(
      "registry rejected stale snapshot",
      { kind: "test-result", suite: "registry-fence" },
      "obs-1",
    );
    const agent = new CitingAgent(HYPOTHESIS_ID, "contradicts");

    const result = await runInvestigationLoop(seedExperimentInvestigation(), agent, {
      maxSteps: 5,
      executor,
    });

    expect(result.steps.map((s) => s.kind)).toEqual([
      "experiment-executed",
      "executed",
      "undetermined",
    ]);
    expect(result.stop).toBe("undetermined");
    // One executor call, one agent run — the experiment ran once and
    // the new evidence was evaluated once, in separate iterations.
    expect(executor.calls).toHaveLength(1);
    expect(agent.calls).toBe(1);
    const evaluated = result.steps[1];
    if (evaluated.kind !== "executed") throw new Error("unreachable");
    expect(evaluated.evaluation).toMatchObject({ hypothesisId: HYPOTHESIS_ID, relation: "contradicts" });
    expect(result.investigation.hypotheses[0]?.status).toBe("refuted");
    expect(result.investigation.status).toBe("unknown");
  });
});

describe("runInvestigationLoop: standing-blind lifecycles", () => {
  function settledWithExperiment(
    standing: "supported" | "refuted" | "inconclusive",
    priorRelation: "supports" | "contradicts" | "inconclusive",
    id = "inv-life",
  ) {
    let investigation = addHypothesis(
      createInvestigation(createGoal("Determine why a task occasionally resurrects after shutdown.", "goal-1"), { id }),
      createHypothesis("A stale snapshot can reintroduce a previously completed task.", HYPOTHESIS_ID),
    );
    investigation = addEvidence(
      investigation,
      createEvidence("prior log line", { kind: "tool-result", tool: "log-reader" }, { id: "ev-0" }),
    );
    const first = createEvaluation("ev-0", HYPOTHESIS_ID, priorRelation, "First assessment.", "eval-0");
    investigation = addEvaluation(
      updateHypothesis(investigation, transitionHypothesis(investigation.hypotheses[0]!, standing)),
      first,
    );
    return addExperiment(
      investigation,
      createExperiment(HYPOTHESIS_ID, PROCEDURE, { falsificationId: FALSIFICATION_ID, id: "exp-1" }),
    );
  }

  it("supported → experiment → contradicting evidence → refuted", async () => {
    const executor = new RegistryFenceExecutor(
      "registry rejected stale snapshot",
      { kind: "test-result", suite: "registry-fence" },
      "obs-1",
    );
    const agent = new CitingAgent(HYPOTHESIS_ID, "contradicts");

    const result = await runInvestigationLoop(
      settledWithExperiment("supported", "supports"),
      agent,
      { maxSteps: 5, executor },
    );

    expect(result.steps.map((s) => s.kind)).toEqual(["experiment-executed", "executed", "undetermined"]);
    expect(result.stop).toBe("undetermined");
    expect(executor.calls).toHaveLength(1);
    expect(agent.calls).toBe(1);
    expect(result.investigation.hypotheses[0]?.status).toBe("refuted");
    expect(result.investigation.status).toBe("unknown");
  });

  it("refuted → experiment → supporting evidence → supported", async () => {
    const executor = new RegistryFenceExecutor(
      "registry accepted fresh snapshot",
      { kind: "test-result", suite: "registry-fence" },
      "obs-1",
    );
    const agent = new CitingAgent(HYPOTHESIS_ID, "supports");

    const result = await runInvestigationLoop(
      settledWithExperiment("refuted", "contradicts"),
      agent,
      { maxSteps: 5, executor },
    );

    expect(result.steps.map((s) => s.kind)).toEqual(["experiment-executed", "executed", "undetermined"]);
    expect(result.stop).toBe("undetermined");
    expect(executor.calls).toHaveLength(1);
    expect(agent.calls).toBe(1);
    expect(result.investigation.hypotheses[0]?.status).toBe("supported");
    expect(result.investigation.status).toBe("unknown");
  });

  it("inconclusive → experiment → evidence → evaluation", async () => {
    const executor = new RegistryFenceExecutor(
      "registry rejected stale snapshot",
      { kind: "test-result", suite: "registry-fence" },
      "obs-1",
    );
    const agent = new CitingAgent(HYPOTHESIS_ID, "supports");

    const result = await runInvestigationLoop(
      settledWithExperiment("inconclusive", "inconclusive"),
      agent,
      { maxSteps: 5, executor },
    );

    expect(result.steps.map((s) => s.kind)).toEqual(["experiment-executed", "executed", "undetermined"]);
    expect(result.stop).toBe("undetermined");
    expect(result.investigation.hypotheses[0]?.status).toBe("supported");
    expect(result.investigation.status).toBe("unknown");
  });

  it("terminates with each experiment executed exactly once", async () => {
    let investigation = addHypothesis(
      createInvestigation(createGoal("Determine why a task occasionally resurrects after shutdown.", "goal-1"), { id: "inv-term" }),
      createHypothesis("A stale snapshot can reintroduce a previously completed task.", HYPOTHESIS_ID),
    );
    investigation = addExperiment(
      investigation,
      createExperiment(HYPOTHESIS_ID, "First probe.", { id: "exp-1" }),
    );
    investigation = addExperiment(
      investigation,
      createExperiment(HYPOTHESIS_ID, "Second probe.", { id: "exp-2" }),
    );

    /** Local executor minting a distinct observation per execution. */
    class CountingExecutor implements ExperimentExecutor {
      calls: Experiment[] = [];
      private runs = 0;

      async execute(experiment: Experiment): Promise<Observation> {
        this.calls.push(experiment);
        this.runs += 1;
        return createObservation(
          "registry rejected stale snapshot",
          { kind: "test-result", suite: "registry-fence" },
          `obs-${this.runs}`,
        );
      }
    }
    const executor = new CountingExecutor();
    const agent = new CitingAgent(HYPOTHESIS_ID, "supports");

    const result = await runInvestigationLoop(investigation, agent, { maxSteps: 10, executor });

    // Finite experiments, one execution each, every pair judged exactly
    // once, then nothing remains: the loop must stop by itself.
    expect(result.steps.map((s) => s.kind)).toEqual([
      "experiment-executed",
      "executed",
      "experiment-executed",
      "executed",
      "undetermined",
    ]);
    expect(executor.calls.map((e) => e.id)).toEqual(["exp-1", "exp-2"]);
    expect(agent.calls).toBe(2);
    expect(result.stop).toBe("undetermined");
    expect(result.investigation.status).toBe("unknown");
  });
});
