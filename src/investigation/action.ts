import { randomUUID } from "node:crypto";
import type { Investigation } from "./investigation.js";

/**
 * A request for investigation work — what should happen next — as
 * opposed to execution itself. An action names the kind of
 * investigation step; it never performs it.
 *
 * Minimal vocabulary, each variant justified by the existing domain
 * (never by speculative heuristics):
 *
 * - `finish`: the investigation's outcome is already explicitly
 *   determined (`succeeded` / `failed`), so no further investigation
 *   work is requested. This READS the explicit status; it never infers
 *   success from agent output, evidence, supported hypotheses, holding
 *   invariants, or recorded revisions.
 * - `evaluate-hypothesis`: an unevaluated `(evidence, hypothesis)`
 *   pair exists. The pair — not the hypothesis alone — is the unit of
 *   work: the same evidence may bear differently on different
 *   hypotheses, and one hypothesis may face many evidences, so a
 *   hypothesis with evaluated evidence can still have pending pairs.
 *   The first pending pair in investigation order (hypotheses, then
 *   evidence) is named, deterministically, with no claim that it is
 *   the optimal one. The evaluation itself (relation + reasoning) is
 *   future work, requested here, never decided.
 * - `run-experiment`: an eligible unexecuted experiment exists and
 *   there is no unevaluated pair to interpret yet (otherwise
 *   `evaluate-hypothesis` fires first — existing evidence is always
 *   interpreted before more is sought). Names the experiment by id,
 *   deterministically the first eligible one in experiment insertion
 *   order, with no claim about optimality. An experiment is eligible
 *   when it has not executed and its target hypothesis exists.
 *   Hypothesis standing does not gate experimentation because
 *   experiment execution produces observations but does not determine
 *   standing; standing changes only through explicit
 *   EvidenceEvaluation. Execution itself is future work, requested
 *   here, never performed.
 * - `undetermined`: the domain cannot determine next work from this
 *   snapshot — e.g. nothing recorded yet, candidates with no evidence
 *   to evaluate them against, or all hypotheses evaluated while the
 *   status stays `unknown`. This is the honest boundary: a future
 *   planner/executor (agents, observations, human judgment) must decide.
 *   Inventing a clever-looking action here would lie about what the
 *   system knows.
 *
 * Distinct from the runtime `Planner` / `Plan` (`src/agents/`), which
 * answer "which agents execute this request" asynchronously. Actions
 * answer "what investigation work is requested"; the runtime will
 * eventually answer "how is it executed". The two never overlap: this
 * module is synchronous, deterministic, and imports nothing outside the
 * investigation domain.
 *
 * Pure data: readonly fields, ids for referenced members (never
 * embedded mutable objects), no callbacks, no runtime handles, no
 * execution. Frozen at creation, following the Phase 1 conventions.
 *
 * Do NOT add speculative actions (prioritized testing, auto-revision,
 * experiment dispatch, agent routing) until a concrete requirement and
 * an executor exist.
 */
export type InvestigationAction =
  | {
      readonly id: string;
      readonly kind: "evaluate-hypothesis";
      readonly hypothesisId: string;
      readonly evidenceId: string;
    }
  | {
      readonly id: string;
      readonly kind: "run-experiment";
      readonly experimentId: string;
    }
  | {
      readonly id: string;
      readonly kind: "finish";
    }
  | {
      readonly id: string;
      readonly kind: "undetermined";
    };

function assertValidId(id: string, owner: string): void {
  if (id.trim() === "") {
    throw new Error(`${owner} id must be a non-empty string`);
  }
}

/**
 * Request evaluation of one unevaluated (evidence, hypothesis) pair.
 * `id` defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known action.
 */
export function createEvaluateHypothesisAction(
  hypothesisId: string,
  evidenceId: string,
  id: string = randomUUID(),
): InvestigationAction {
  assertValidId(id, "InvestigationAction");
  if (hypothesisId.trim() === "") {
    throw new Error("evaluate-hypothesis action requires a non-empty hypothesisId");
  }
  if (evidenceId.trim() === "") {
    throw new Error("evaluate-hypothesis action requires a non-empty evidenceId");
  }
  return Object.freeze({ id, kind: "evaluate-hypothesis" as const, hypothesisId, evidenceId });
}

/**
 * Request execution of one planned experiment. `id` defaults to a
 * fresh UUID; pass an explicit id in tests and when rehydrating a
 * known action.
 */
export function createRunExperimentAction(
  experimentId: string,
  id: string = randomUUID(),
): InvestigationAction {
  assertValidId(id, "InvestigationAction");
  if (experimentId.trim() === "") {
    throw new Error("run-experiment action requires a non-empty experimentId");
  }
  return Object.freeze({ id, kind: "run-experiment" as const, experimentId });
}

/**
 * Record that no further investigation work is requested because the
 * outcome is already determined. `id` defaults to a fresh UUID; pass
 * an explicit id in tests and when rehydrating a known action.
 */
export function createFinishAction(id: string = randomUUID()): InvestigationAction {
  assertValidId(id, "InvestigationAction");
  return Object.freeze({ id, kind: "finish" as const });
}

/**
 * Record that next work cannot be determined from investigation state
 * alone. `id` defaults to a fresh UUID; pass an explicit id in tests
 * and when rehydrating a known action.
 */
export function createUndeterminedAction(id: string = randomUUID()): InvestigationAction {
  assertValidId(id, "InvestigationAction");
  return Object.freeze({ id, kind: "undetermined" as const });
}

/**
 * Decide the next requested investigation step for a snapshot.
 *
 * Pure and deterministic: reads only the given investigation, calls
 * nothing (no LLM, no agents, no clock, no I/O), mutates nothing, and
 * returns a frozen action. The same snapshot always yields the same
 * kind and the same referenced ids; pass an explicit `id` for
 * byte-identical results across calls (the default fresh UUID is
 * instance identity, not decision content).
 *
 * Rule order, each structurally justified:
 *
 * 1. Determined outcome (`succeeded` / `failed`) → `finish`.
 * 2. Otherwise, first unevaluated `(evidence, hypothesis)` pair in
 *    investigation order (hypotheses, then evidence) →
 *    `evaluate-hypothesis`. A pair is pending when both members exist
 *    and no stored evaluation judges that exact pair yet. Standing
 *    gates nothing: evaluated hypotheses with fresh evidence are
 *    re-evaluable, which is how revisability happens. `hypothesisIds`
 *    linkage is metadata, never an eligibility gate; source
 *    provenance never gates either. Existing unevaluated pairs are
 *    always interpreted before more work is sought: this rule wins
 *    over rule 3 exactly as it does today.
 * 3. Otherwise, first unexecuted experiment in experiment insertion
 *    order whose target hypothesis exists → `run-experiment`. An
 *    experiment is eligible when it has not executed and its target
 *    hypothesis exists — standing plays no role, since execution
 *    produces observations without determining standing. No
 *    model-staleness, falsification, priority, or scoring logic.
 * 4. Otherwise → `undetermined`.
 *
 * Deciding never executes, never mutates the investigation, never
 * evaluates anything, and never changes any status or standing.
 */
export function decideNextInvestigationAction(
  investigation: Investigation,
  options: { id?: string } = {},
): InvestigationAction {
  const id = options.id ?? randomUUID();
  if (investigation.status === "succeeded" || investigation.status === "failed") {
    return createFinishAction(id);
  }
  // Same pair key shape as the aggregate's evaluation uniqueness check:
  // [evidenceId, hypothesisId] encoded identically on both sides.
  const evaluatedPairs = new Set(
    investigation.evaluations.map((e) => JSON.stringify([e.evidenceId, e.hypothesisId])),
  );
  for (const hypothesis of investigation.hypotheses) {
    const pending = investigation.evidence.find(
      (e) => !evaluatedPairs.has(JSON.stringify([e.id, hypothesis.id])),
    );
    if (pending !== undefined) {
      return createEvaluateHypothesisAction(hypothesis.id, pending.id, id);
    }
  }
  const executedIds = new Set(investigation.experimentExecutions.map((e) => e.experimentId));
  const hypothesisIds = new Set(investigation.hypotheses.map((h) => h.id));
  const experiment = investigation.experiments.find(
    (e) => !executedIds.has(e.id) && hypothesisIds.has(e.hypothesisId),
  );
  if (experiment !== undefined) {
    return createRunExperimentAction(experiment.id, id);
  }
  return createUndeterminedAction(id);
}
