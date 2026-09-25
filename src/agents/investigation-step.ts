import type { Agent } from "./agent.js";
import type { AgentResult } from "./result.js";
import type { Investigation } from "../investigation/investigation.js";
import {
  addEvaluation,
  addEvidence,
  addExecutionRecord,
  addExperimentExecution,
  addObservation,
  updateHypothesis,
} from "../investigation/investigation.js";
import type { InvestigationAction } from "../investigation/action.js";
import { decideNextInvestigationAction } from "../investigation/action.js";
import type { Evidence } from "../investigation/evidence.js";
import type { EvidenceEvaluation } from "../investigation/evaluation.js";
import { applyEvaluation } from "../investigation/evaluation.js";
import type { ExecutionRecord } from "../investigation/execution-record.js";
import type { Experiment } from "../investigation/experiment.js";
import type { ExperimentExecution } from "../investigation/experiment-execution.js";
import type { ExperimentExecutor, ExperimentExecutorSelector } from "./experiment-executor.js";
import type { Observation } from "../investigation/observation.js";
import { investigationActionToRequest } from "./action-request.js";
import { agentResultToEvaluation } from "./result-evaluation.js";
import { createExecutionRecord } from "./execution-record.js";
import { createExperimentExecution } from "./experiment-execution.js";
import { observationToEvidence } from "./observation-evidence.js";

/**
 * The outcome of one investigation step. Explicit structured state —
 * callers branch on `kind` (and `failure`), never on message strings:
 *
 * - `finish`: the investigation was already determined; no agent ran;
 *   the returned investigation is the unchanged input snapshot.
 * - `undetermined`: the domain could not justify an execution step; no
 *   agent ran (and NOT an error — nothing failed); the returned
 *   investigation is the unchanged input snapshot.
 * - `executed`: one `evaluate-hypothesis` action ran exactly once:
 *   the selected pair was proposed, the durable evaluation appended,
 *   and the hypothesis re-standing via the domain transition; the
 *   returned investigation is a new snapshot holding the evaluation,
 *   the execution record (with `evidenceId: null` — evaluation
 *   interprets existing evidence rather than producing new evidence),
 *   and the updated hypothesis. `evidence` is `null` on this path for
 *   the same reason.
 * - `experiment-executed`: one `run-experiment` action ran exactly
 *   once through the injected `ExperimentExecutor`; the returned
 *   investigation is a new snapshot holding the new observation, the
 *   experiment execution lineage, and the unconditionally promoted
 *   evidence. No evaluation occurs and no standing changes.
 * - `step-failed`: the step, not the investigation, failed —
 *   `failure` says which boundary stopped it (`no-evidence`: retained
 *   in the taxonomy for discovery-style executions that produce
 *   nothing usable — no current in-step path produces it, since the
 *   evaluation path interprets rather than extracts and the experiment
 *   path fails as `execution-failed`;
 *   `evaluation-failed`: no valid evaluation proposal emerged, so the
 *   input snapshot returns untouched and standing is untouched;
 *   `execution-failed`: the experiment executor itself
 *   failed, so no observation, lineage, or evidence exists).
 *   `detail` carries the underlying error message. `agentResult` is
 *   present only for agent-path outcomes — experiment execution
 *   involves no `AgentResult`.
 *   `Investigation.status` is never set here: a failed attempt is not
 *   a failed investigation.
 */
export type InvestigationStepResult =
  | {
      readonly kind: "finish";
      readonly action: InvestigationAction;
      readonly investigation: Investigation;
    }
  | {
      readonly kind: "undetermined";
      readonly action: InvestigationAction;
      readonly investigation: Investigation;
    }
  | {
      readonly kind: "executed";
      readonly action: InvestigationAction;
      readonly investigation: Investigation;
      readonly agentResult: AgentResult;
      readonly evidence: Evidence | null;
      readonly record: ExecutionRecord;
      readonly evaluation: EvidenceEvaluation;
    }
  | {
      readonly kind: "experiment-executed";
      readonly action: InvestigationAction;
      readonly investigation: Investigation;
      readonly experiment: Experiment;
      readonly observation: Observation;
      readonly evidence: Evidence;
      readonly experimentExecution: ExperimentExecution;
    }
  | {
      readonly kind: "step-failed";
      readonly action: InvestigationAction;
      readonly investigation: Investigation;
      readonly failure: "no-evidence" | "evaluation-failed" | "execution-failed";
      readonly detail: string;
      readonly agentResult: AgentResult | null;
      readonly evidence: Evidence | null;
      readonly record: ExecutionRecord | null;
    };

export interface InvestigationStepOptions {
  readonly actionId?: string;
  readonly evidenceId?: string;
  readonly recordId?: string;
  readonly evaluationId?: string;
  readonly experimentExecutionId?: string;
  /**
   * Capability performing `run-experiment` actions. Injected, never
   * constructed here; required when the decided action is
   * `run-experiment`, unused otherwise. Must NOT be an `Agent.run()`
   * wrapper — experiment execution is capability execution.
   */
  readonly executor?: ExperimentExecutor;
  /**
   * Optional per-experiment capability choice, for callers operating
   * more than one trusted executor. A plain caller-owned function —
   * not a registry: it maps an experiment id the caller already knows
   * to a pre-built instance. When present it takes precedence over
   * `executor` for `run-experiment` actions; when absent, `executor`
   * is used exactly as before.
   */
  readonly executorForExperiment?: ExperimentExecutorSelector;
}

/**
 * Perform exactly ONE investigation step: one decision, at most one
 * `Agent.run()`, one resulting state. No loop, no retries, no
 * follow-ups — call this again for another step.
 *
 * Execution sequence for an executable action, reusing every existing
 * primitive in order (each boundary from Phases 1–10 stays intact):
 *
 * 1. `decideNextInvestigationAction()` — pure domain decision.
 * 2. `finish` / `undetermined` → return immediately; no agent runs,
 *    nothing changes.
 * 3. `evaluate-hypothesis` → `investigationActionToRequest()` builds
 *    the existing `Agent.run(input, context)` pair for the selected
 *    evidence/hypothesis pair (whose prompt already states the strict
 *    evaluation-output contract).
 * 4. `await agent.run(...)`. Only the `result` channel is consumed;
 *    per the `AgentRun` contract it settles whether or not anyone
 *    drains `events`, so no streaming is needed here.
 * 5. `agentResultToEvaluation()` parses the assessment prose into a
 *    proposal about the selected pair. The output is NEVER converted
 *    into Evidence: assessment prose is reasoning about existing
 *    evidence, not new world-evidence, so one evaluation step
 *    consumes exactly one unevaluated pair, produces exactly one
 *    evaluation, and produces zero evidence — evaluation cannot
 *    self-seed. Parse failure stops here as `evaluation-failed` with
 *    the input snapshot untouched.
 * 6. `addEvaluation()` appends the durable evaluation, then the
 *    existing `applyEvaluation()` + `updateHypothesis()` move the
 *    standing. The domain — never this orchestrator, never the
 *    agent — owns the transition.
 * 7. `createExecutionRecord()` with `evidence: null` (nothing
 *    extracted) + `addExecutionRecord()` — the execution still leaves
 *    honest lineage: action ran, result settled, evaluation stored.
 *
 * For a `run-experiment` action the sequence is instead: resolve the
 * experiment from the snapshot, re-check eligibility (target exists,
 * never executed — standing plays no role), `await executor.execute()`
 * (the ONLY `await` that performs experiment work — never `Agent.run`),
 * `addObservation()`, `createExperimentExecution()` +
 * `addExperimentExecution()`, unconditional `observationToEvidence()`
 * + `addEvidence()`. Executor failure stops as `execution-failed`
 * with nothing recorded and no retry. No evaluation, no standing
 * change, no status change — the new evidence simply feeds the next
 * decision, which may become `evaluate-hypothesis`.
 *
 * Purity notes: the input snapshot and all its members are never
 * mutated (new frozen snapshots only); `Investigation.status` is never
 * written here — check the imports: no `setInvestigationStatus`, no
 * status assignment. Decision determinism is inherited (same snapshot
 * → same action); execution output depends on the agent, so only the
 * decision — not the whole step — is deterministic.
 *
 * Lives on the runtime side (`src/agents/`) next to the adapters it
 * composes; `src/investigation/` remains runtime-free.
 *
 * Do NOT add loops, retries, scheduling, persistence, hypothesis
 * generation, or any other automation — this is one step only.
 */
export async function runInvestigationStep(
  investigation: Investigation,
  agent: Agent,
  options: InvestigationStepOptions = {},
): Promise<InvestigationStepResult> {
  const action = decideNextInvestigationAction(investigation, { id: options.actionId });
  if (action.kind === "finish") {
    return { kind: "finish", action, investigation };
  }
  if (action.kind === "undetermined") {
    return { kind: "undetermined", action, investigation };
  }
  if (action.kind === "run-experiment") {
    // A caller-supplied selector chooses the trusted capability for
    // this experiment id; otherwise the single injected executor runs
    // it, exactly as before. Selection never reads experiment prose,
    // model output, or user text.
    const executor = options.executorForExperiment
      ? options.executorForExperiment(action.experimentId)
      : options.executor;
    return runExperimentStep(investigation, action, executor, {
      evidenceId: options.evidenceId,
      experimentExecutionId: options.experimentExecutionId,
    });
  }

  const request = investigationActionToRequest(action, investigation);
  if (request === null) {
    throw new Error("evaluate-hypothesis produced no execution request");
  }
  // The pair under judgment, resolved before spending execution: the
  // action names exact members, so unknown ids fail fast here rather
  // than after the agent has run.
  const evidence = investigation.evidence.find((e) => e.id === action.evidenceId);
  if (evidence === undefined) {
    throw new Error(`Unknown evidence id: ${JSON.stringify(action.evidenceId)}`);
  }
  const run = agent.run(request.input, request.context);
  const agentResult = await run.result;

  // The agent output is assessment prose about the selected pair, not
  // new world-evidence: it is parsed into a proposal and never
  // converted into Evidence. One evaluation step therefore consumes
  // exactly one unevaluated pair, produces exactly one evaluation,
  // and produces zero evidence — evaluation cannot self-seed.
  let evaluation: EvidenceEvaluation;
  try {
    evaluation = agentResultToEvaluation(action, agentResult, evidence, {
      id: options.evaluationId,
    });
  } catch (err) {
    return {
      kind: "step-failed",
      action,
      investigation,
      failure: "evaluation-failed",
      detail: err instanceof Error ? err.message : String(err),
      agentResult,
      evidence: null,
      record: null,
    };
  }

  const hypothesis = investigation.hypotheses.find((h) => h.id === action.hypothesisId);
  if (hypothesis === undefined) {
    throw new Error(`Unknown hypothesis id: ${JSON.stringify(action.hypothesisId)}`);
  }
  // Append before apply, per the domain sequence (proposal → validate
  // → append → apply). All three operations are pure and commit only
  // through the local snapshot chain, so a throw anywhere below still
  // returns the pristine input — a failed evaluation never partially
  // commits.
  let updated = addEvaluation(investigation, evaluation);
  const transitioned = applyEvaluation(hypothesis, evaluation);
  updated = updateHypothesis(updated, transitioned);
  const record = createExecutionRecord(action, agentResult, null, options.recordId);
  updated = addExecutionRecord(updated, record);
  return {
    kind: "executed",
    action,
    investigation: updated,
    agentResult,
    evidence: null,
    record,
    evaluation,
  };
}

/**
 * Execute one already-decided `run-experiment` action: resolve, re-check eligibility,
 * run the injected executor exactly once, and record observation,
 * lineage, and unconditionally promoted evidence. Only executor
 * failure is caught (as `execution-failed` with nothing recorded);
 * synchronous domain/invariant errors propagate visibly, as elsewhere.
 * Never evaluates, never changes standing or status.
 *
 * Exported for callers (and tests) holding an already-decided action;
 * `runInvestigationStep` above is the decide-and-execute entry point.
 */
export async function runExperimentStep(
  investigation: Investigation,
  action: InvestigationAction,
  executor: ExperimentExecutor | undefined,
  ids: { evidenceId?: string; experimentExecutionId?: string },
): Promise<InvestigationStepResult> {
  if (action.kind !== "run-experiment") {
    throw new Error(
      `Cannot run experiment for ${JSON.stringify(action.kind)} action: it requests no experiment execution`,
    );
  }
  if (executor === undefined) {
    throw new Error("run-experiment requires an ExperimentExecutor");
  }
  const experiment = investigation.experiments.find((e) => e.id === action.experimentId);
  if (experiment === undefined) {
    throw new Error(`Unknown experiment id: ${JSON.stringify(action.experimentId)}`);
  }
  const targetExists = investigation.hypotheses.some((h) => h.id === experiment.hypothesisId);
  if (!targetExists) {
    throw new Error(`Unknown hypothesis id: ${JSON.stringify(experiment.hypothesisId)}`);
  }
  if (investigation.experimentExecutions.some((e) => e.experimentId === experiment.id)) {
    throw new Error(`Experiment ${JSON.stringify(experiment.id)} has already been executed`);
  }
  let observation: Observation;
  try {
    observation = await executor.execute(experiment);
  } catch (err) {
    return {
      kind: "step-failed",
      action,
      investigation,
      failure: "execution-failed",
      detail: err instanceof Error ? err.message : String(err),
      agentResult: null,
      evidence: null,
      record: null,
    };
  }
  let updated = addObservation(investigation, observation);
  const experimentExecution = createExperimentExecution(experiment, observation, ids.experimentExecutionId);
  updated = addExperimentExecution(updated, experimentExecution);
  const evidence = observationToEvidence(observation, { id: ids.evidenceId });
  updated = addEvidence(updated, evidence);
  return {
    kind: "experiment-executed",
    action,
    investigation: updated,
    experiment,
    observation,
    evidence,
    experimentExecution,
  };
}
