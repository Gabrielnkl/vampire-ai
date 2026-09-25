import { randomUUID } from "node:crypto";
import type { Goal } from "./goal.js";
import type { Observation } from "./observation.js";
import type { Evidence } from "./evidence.js";
import type { EvidenceEvaluation } from "./evaluation.js";
import type { ExecutionRecord } from "./execution-record.js";
import type { Experiment } from "./experiment.js";
import type { ExperimentExecution } from "./experiment-execution.js";
import type { Falsification } from "./falsification.js";
import type { Hypothesis } from "./hypothesis.js";
import type { Invariant } from "./invariant.js";
import type { InvariantCheck } from "./invariant-check.js";
import type { ModelRevision } from "./model-revision.js";

/**
 * Outcome determination for the whole investigation:
 *
 * - `unknown`: we do not know yet. This is the initial state and the
 *   honest standing while work is underway — explicitly distinct from
 *   both success and failure, so "no determination" is never misread
 *   from the latest agent message or mistaken for an outcome.
 * - `succeeded`: the goal is understood / accomplished.
 * - `failed`: the investigation cannot reach its goal.
 *
 * Kept minimal on purpose: this tracks determination, not activity —
 * there is deliberately no `open` / `in-progress` state, since
 * "underway but undetermined" is exactly what `unknown` means.
 */
export type InvestigationStatus = "unknown" | "succeeded" | "failed";

/**
 * The current investigation: its goal, its explicit outcome status, and
 * the observations, hypotheses, evidence, evaluations, invariants,
 * falsification criteria, invariant checks, model revisions, execution
 * records, experiments, and experiment executions gathered so far.
 *
 * Immutable aggregate (like `AgentResult`, unlike the mutable
 * `Conversation`): every `add*` / `update*` / `set*` function returns a
 * new frozen object and leaves the input untouched, so earlier states of
 * the investigation stay representable. The status is always explicit —
 * never inferred from member contents or from any agent message.
 *
 * Do NOT add autonomous-loop machinery (planning, falsification,
 * revision, verification, execution hooks) here — that is Phase 2.
 */
export interface Investigation {
  readonly id: string;
  readonly goal: Goal;
  readonly status: InvestigationStatus;
  readonly observations: readonly Observation[];
  readonly hypotheses: readonly Hypothesis[];
  readonly evidence: readonly Evidence[];
  readonly evaluations: readonly EvidenceEvaluation[];
  readonly invariants: readonly Invariant[];
  readonly falsifications: readonly Falsification[];
  readonly invariantChecks: readonly InvariantCheck[];
  readonly modelRevisions: readonly ModelRevision[];
  readonly executionRecords: readonly ExecutionRecord[];
  readonly experiments: readonly Experiment[];
  readonly experimentExecutions: readonly ExperimentExecution[];
}

export interface InvestigationInit {
  readonly id?: string;
  readonly status?: InvestigationStatus;
  readonly observations?: readonly Observation[];
  readonly hypotheses?: readonly Hypothesis[];
  readonly evidence?: readonly Evidence[];
  readonly evaluations?: readonly EvidenceEvaluation[];
  readonly invariants?: readonly Invariant[];
  readonly falsifications?: readonly Falsification[];
  readonly invariantChecks?: readonly InvariantCheck[];
  readonly modelRevisions?: readonly ModelRevision[];
  readonly executionRecords?: readonly ExecutionRecord[];
  readonly experiments?: readonly Experiment[];
  readonly experimentExecutions?: readonly ExperimentExecution[];
}

function assertUniqueIds(kind: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${kind} id: ${JSON.stringify(id)}`);
    }
    seen.add(id);
  }
}

function assertValidStatus(status: InvestigationStatus): void {
  if (status !== "unknown" && status !== "succeeded" && status !== "failed") {
    throw new Error(`Invalid investigation status: ${JSON.stringify(status)}`);
  }
}

/**
 * The uniqueness key of an evaluation is the judged pair, not the
 * evaluation id: two records for the same `(evidenceId, hypothesisId)`
 * would be two verdicts on one question with no reconciliation rule.
 */
function evaluationPairKey(evaluation: Pick<EvidenceEvaluation, "evidenceId" | "hypothesisId">): string {
  return JSON.stringify([evaluation.evidenceId, evaluation.hypothesisId]);
}

function assertUniqueEvaluationPairs(evaluations: readonly EvidenceEvaluation[]): void {
  const seen = new Set<string>();
  for (const evaluation of evaluations) {
    const key = evaluationPairKey(evaluation);
    if (seen.has(key)) {
      throw new Error(
        `Duplicate evaluation for evidence ${JSON.stringify(evaluation.evidenceId)} and hypothesis ${JSON.stringify(evaluation.hypothesisId)}`,
      );
    }
    seen.add(key);
  }
}

/**
 * Seal a freshly started investigation. Defaults to status `unknown`
 * ("we do not know yet") with empty collections; `id` defaults to a
 * fresh UUID. Duplicate member ids are rejected up front.
 */
export function createInvestigation(goal: Goal, init: InvestigationInit = {}): Investigation {
  const id = init.id ?? randomUUID();
  if (id.trim() === "") {
    throw new Error("Investigation id must be a non-empty string");
  }
  const status = init.status ?? "unknown";
  assertValidStatus(status);
  const observations = [...(init.observations ?? [])];
  const hypotheses = [...(init.hypotheses ?? [])];
  const evidence = [...(init.evidence ?? [])];
  const evaluations = [...(init.evaluations ?? [])];
  const invariants = [...(init.invariants ?? [])];
  const falsifications = [...(init.falsifications ?? [])];
  const invariantChecks = [...(init.invariantChecks ?? [])];
  const modelRevisions = [...(init.modelRevisions ?? [])];
  const executionRecords = [...(init.executionRecords ?? [])];
  const experiments = [...(init.experiments ?? [])];
  const experimentExecutions = [...(init.experimentExecutions ?? [])];
  assertUniqueIds("observation", observations.map((o) => o.id));
  assertUniqueIds("hypothesis", hypotheses.map((h) => h.id));
  assertUniqueIds("evidence", evidence.map((e) => e.id));
  assertUniqueEvaluationPairs(evaluations);
  assertUniqueIds("invariant", invariants.map((i) => i.id));
  assertUniqueIds("falsification", falsifications.map((f) => f.id));
  assertUniqueIds("invariantCheck", invariantChecks.map((c) => c.id));
  assertUniqueIds("modelRevision", modelRevisions.map((r) => r.id));
  assertUniqueIds("executionRecord", executionRecords.map((r) => r.id));
  assertUniqueIds("experiment", experiments.map((e) => e.id));
  assertUniqueIds("experimentExecution", experimentExecutions.map((e) => e.id));
  return Object.freeze({
    id,
    goal,
    status,
    observations: Object.freeze(observations),
    hypotheses: Object.freeze(hypotheses),
    evidence: Object.freeze(evidence),
    evaluations: Object.freeze(evaluations),
    invariants: Object.freeze(invariants),
    falsifications: Object.freeze(falsifications),
    invariantChecks: Object.freeze(invariantChecks),
    modelRevisions: Object.freeze(modelRevisions),
    executionRecords: Object.freeze(executionRecords),
    experiments: Object.freeze(experiments),
    experimentExecutions: Object.freeze(experimentExecutions),
  });
}

/**
 * Record an observation. Rejects duplicate observation ids so two
 * distinct sightings can never silently share an identity.
 */
export function addObservation(
  investigation: Investigation,
  observation: Observation,
): Investigation {
  if (investigation.observations.some((o) => o.id === observation.id)) {
    throw new Error(`Duplicate observation id: ${JSON.stringify(observation.id)}`);
  }
  return Object.freeze({
    ...investigation,
    observations: Object.freeze([...investigation.observations, observation]),
  });
}

/**
 * Propose a hypothesis. Refuted hypotheses already present are kept —
 * this function only appends, never removes or rewrites.
 */
export function addHypothesis(
  investigation: Investigation,
  hypothesis: Hypothesis,
): Investigation {
  if (investigation.hypotheses.some((h) => h.id === hypothesis.id)) {
    throw new Error(`Duplicate hypothesis id: ${JSON.stringify(hypothesis.id)}`);
  }
  return Object.freeze({
    ...investigation,
    hypotheses: Object.freeze([...investigation.hypotheses, hypothesis]),
  });
}

/**
 * Replace the stored hypothesis with the same id (the way a
 * `transitionHypothesis` result is published back into the aggregate).
 * Identity must already exist — this never invents membership — and the
 * replaced value (including a `refuted` one) is simply superseded in
 * this newer snapshot, while older snapshots still hold it.
 */
export function updateHypothesis(
  investigation: Investigation,
  hypothesis: Hypothesis,
): Investigation {
  if (!investigation.hypotheses.some((h) => h.id === hypothesis.id)) {
    throw new Error(`Unknown hypothesis id: ${JSON.stringify(hypothesis.id)}`);
  }
  return Object.freeze({
    ...investigation,
    hypotheses: Object.freeze(
      investigation.hypotheses.map((h) => (h.id === hypothesis.id ? hypothesis : h)),
    ),
  });
}

/**
 * Gather evidence into the investigation. Never promotes anything:
 * adding evidence neither evaluates hypotheses nor changes the status.
 */
export function addEvidence(investigation: Investigation, evidence: Evidence): Investigation {
  if (investigation.evidence.some((e) => e.id === evidence.id)) {
    throw new Error(`Duplicate evidence id: ${JSON.stringify(evidence.id)}`);
  }
  return Object.freeze({
    ...investigation,
    evidence: Object.freeze([...investigation.evidence, evidence]),
  });
}

/**
 * Replace the stored evidence with the same id (the way a
 * `linkEvidenceToHypothesis` result is published back into the
 * aggregate). Identity must already exist.
 */
export function updateEvidence(investigation: Investigation, evidence: Evidence): Investigation {
  if (!investigation.evidence.some((e) => e.id === evidence.id)) {
    throw new Error(`Unknown evidence id: ${JSON.stringify(evidence.id)}`);
  }
  return Object.freeze({
    ...investigation,
    evidence: Object.freeze(
      investigation.evidence.map((e) => (e.id === evidence.id ? evidence : e)),
    ),
  });
}

/**
 * Record an applied evaluation as durable history, in application
 * order. The evaluation itself changes nothing — standing moves only
 * through a separate `applyEvaluation` + `updateHypothesis` — but
 * retaining it answers "why does this hypothesis hold this standing?"
 * Rejects a second evaluation of the same `(evidenceId, hypothesisId)`
 * pair: one question, one verdict, never overwritten, never deleted.
 */
export function addEvaluation(
  investigation: Investigation,
  evaluation: EvidenceEvaluation,
): Investigation {
  if (
    investigation.evaluations.some(
      (e) => e.evidenceId === evaluation.evidenceId && e.hypothesisId === evaluation.hypothesisId,
    )
  ) {
    throw new Error(
      `Duplicate evaluation for evidence ${JSON.stringify(evaluation.evidenceId)} and hypothesis ${JSON.stringify(evaluation.hypothesisId)}`,
    );
  }
  return Object.freeze({
    ...investigation,
    evaluations: Object.freeze([...investigation.evaluations, evaluation]),
  });
}

/**
 * State an invariant. Recording it claims only that it should hold —
 * nothing here checks whether it does.
 */
export function addInvariant(investigation: Investigation, invariant: Invariant): Investigation {
  if (investigation.invariants.some((i) => i.id === invariant.id)) {
    throw new Error(`Duplicate invariant id: ${JSON.stringify(invariant.id)}`);
  }
  return Object.freeze({
    ...investigation,
    invariants: Object.freeze([...investigation.invariants, invariant]),
  });
}

/**
 * State a falsification criterion. Recording what WOULD contradict a
 * hypothesis observes nothing and decides nothing: the hypothesis keeps
 * its standing and the investigation keeps its status. Only future
 * evidence, evaluated against the hypothesis, can change either.
 * Rejects duplicate falsification ids; several criteria may reference
 * the same hypothesis.
 */
export function addFalsification(
  investigation: Investigation,
  falsification: Falsification,
): Investigation {
  if (investigation.falsifications.some((f) => f.id === falsification.id)) {
    throw new Error(`Duplicate falsification id: ${JSON.stringify(falsification.id)}`);
  }
  return Object.freeze({
    ...investigation,
    falsifications: Object.freeze([...investigation.falsifications, falsification]),
  });
}

/**
 * Record one checking of an invariant against evidence. The check is a
 * new immutable record — re-checking the same invariant creates another
 * check, never rewrites one — so `holds` then `violated` stays fully
 * representable. Recording a check, even a `violated` one, derives
 * nothing: no hypothesis changes standing and the investigation keeps
 * its status. Rejects duplicate check ids.
 */
export function addInvariantCheck(
  investigation: Investigation,
  check: InvariantCheck,
): Investigation {
  if (investigation.invariantChecks.some((c) => c.id === check.id)) {
    throw new Error(`Duplicate invariantCheck id: ${JSON.stringify(check.id)}`);
  }
  return Object.freeze({
    ...investigation,
    invariantChecks: Object.freeze([...investigation.invariantChecks, check]),
  });
}

/**
 * Record a change in the investigation's explanatory model. Revisions
 * are historical records and append-only: a newer revision never
 * rewrites an earlier one, so the full A → B → C chain stays available.
 * Recording a revision derives nothing on its own: no hypothesis is
 * created, none changes standing, and the investigation keeps its
 * status. Rejects duplicate revision ids.
 */
export function addModelRevision(
  investigation: Investigation,
  revision: ModelRevision,
): Investigation {
  if (investigation.modelRevisions.some((r) => r.id === revision.id)) {
    throw new Error(`Duplicate modelRevision id: ${JSON.stringify(revision.id)}`);
  }
  return Object.freeze({
    ...investigation,
    modelRevisions: Object.freeze([...investigation.modelRevisions, revision]),
  });
}

/**
 * Record the causal chain behind newly gathered evidence: which action
 * was executed and which result it produced. Records are historical and
 * append-only — a record never rewrites an earlier one — so the full
 * action → result → evidence lineage stays inspectable. Recording
 * derives nothing: the linked evidence stays ordinary unevaluated
 * evidence, no hypothesis changes standing, and the investigation keeps
 * its status. Rejects duplicate record ids.
 */
export function addExecutionRecord(
  investigation: Investigation,
  record: ExecutionRecord,
): Investigation {
  if (investigation.executionRecords.some((r) => r.id === record.id)) {
    throw new Error(`Duplicate executionRecord id: ${JSON.stringify(record.id)}`);
  }
  return Object.freeze({
    ...investigation,
    executionRecords: Object.freeze([...investigation.executionRecords, record]),
  });
}

/**
 * Propose an experiment plan. Recording how useful evidence COULD be
 * produced produces nothing: no observation, no evidence, no standing
 * change, no status change — a plan is not an execution. Rejects
 * duplicate experiment ids; several experiments may target the same
 * hypothesis. Referenced hypothesis/falsification ids are recorded as
 * given (ID-reference style); membership is not validated here, matching
 * the other append-only collections.
 */
export function addExperiment(
  investigation: Investigation,
  experiment: Experiment,
): Investigation {
  if (investigation.experiments.some((e) => e.id === experiment.id)) {
    throw new Error(`Duplicate experiment id: ${JSON.stringify(experiment.id)}`);
  }
  return Object.freeze({
    ...investigation,
    experiments: Object.freeze([...investigation.experiments, experiment]),
  });
}

/**
 * Record which execution of which experiment produced which
 * observation. Lineage only: recording it creates no evidence,
 * evaluates nothing, and changes no standing or status. Rejects
 * duplicate execution ids; lineage entries accumulate in insertion
 * order and are never rewritten.
 */
export function addExperimentExecution(
  investigation: Investigation,
  execution: ExperimentExecution,
): Investigation {
  if (investigation.experimentExecutions.some((e) => e.id === execution.id)) {
    throw new Error(`Duplicate experimentExecution id: ${JSON.stringify(execution.id)}`);
  }
  return Object.freeze({
    ...investigation,
    experimentExecutions: Object.freeze([...investigation.experimentExecutions, execution]),
  });
}

/**
 * Determine the investigation's outcome explicitly. Any status may
 * follow any other (including reopening to `unknown`) — the caller
 * decides, the model only records. Rejects values outside
 * `InvestigationStatus` from untyped callers at runtime.
 */
export function setInvestigationStatus(
  investigation: Investigation,
  status: InvestigationStatus,
): Investigation {
  assertValidStatus(status);
  return Object.freeze({ ...investigation, status });
}
