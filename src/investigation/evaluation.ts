import { randomUUID } from "node:crypto";
import type { Hypothesis, HypothesisStatus } from "./hypothesis.js";
import { transitionHypothesis } from "./hypothesis.js";

/**
 * How one piece of evidence relates to one hypothesis, as determined by
 * an explicit reasoning act — as opposed to `Evidence.hypothesisIds`,
 * which only records linkage ("this bears on that") without a verdict.
 *
 * The relation is strictly relational: the SAME evidence may support one
 * hypothesis while being inconclusive against another, so the verdict
 * lives here — on the (evidence, hypothesis) pair — never on the
 * `Evidence` itself. `Evidence` carries no `supports` / `verdict`
 * field, by design.
 *
 * - `supports`: the evidence speaks for the hypothesis.
 * - `contradicts`: the evidence speaks against the hypothesis.
 * - `inconclusive`: the evidence was considered and settles nothing
 *   either way (distinct from "never evaluated": this IS an evaluated
 *   outcome).
 *
 * `reasoning` records WHY the relation was assigned, so the runtime can
 * later inspect the explanation. It is an explanation of the evaluation,
 * not independent evidence and not authoritative truth.
 *
 * Immutable value object, frozen at creation. Takes plain ids (not the
 * `Evidence` / `Hypothesis` objects) so evaluating never requires —
 * and never mutates — the evaluated members.
 *
 * No provenance: an evaluation is a domain reasoning record, and the
 * existing architecture requires no producer tracking for it. No
 * confidence scores, weights, or probabilities — a single explicit
 * evaluation per (evidence, hypothesis) pair is enough for this phase.
 *
 * Do NOT add scoring, Bayesian reasoning, automatic evaluation from the
 * runtime, or falsification experiments here — those belong to later
 * phases.
 */
export type EvaluationRelation = "supports" | "contradicts" | "inconclusive";

export interface EvidenceEvaluation {
  readonly id: string;
  readonly evidenceId: string;
  readonly hypothesisId: string;
  readonly relation: EvaluationRelation;
  readonly reasoning: string;
}

function assertValidRelation(relation: EvaluationRelation): void {
  if (relation !== "supports" && relation !== "contradicts" && relation !== "inconclusive") {
    throw new Error(`Invalid evaluation relation: ${JSON.stringify(relation)}`);
  }
}

/**
 * Seal a fresh evaluation of one evidence against one hypothesis.
 * `id` defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known evaluation. All identity and reasoning fields must
 * be non-empty — never a sentinel.
 */
export function createEvaluation(
  evidenceId: string,
  hypothesisId: string,
  relation: EvaluationRelation,
  reasoning: string,
  id: string = randomUUID(),
): EvidenceEvaluation {
  if (id.trim() === "") {
    throw new Error("Evaluation id must be a non-empty string");
  }
  if (evidenceId.trim() === "") {
    throw new Error("Evaluation evidenceId must be a non-empty string");
  }
  if (hypothesisId.trim() === "") {
    throw new Error("Evaluation hypothesisId must be a non-empty string");
  }
  assertValidRelation(relation);
  if (reasoning.trim() === "") {
    throw new Error("Evaluation reasoning must be a non-empty string");
  }
  return Object.freeze({ id, evidenceId, hypothesisId, relation, reasoning });
}

/**
 * The standing each relation assigns: supports → supported,
 * contradicts → refuted, inconclusive → inconclusive. There is
 * deliberately no mapping to `candidate` — applying an evaluation means
 * the hypothesis HAS been evaluated, so "never evaluated" can never be
 * the outcome.
 */
const RELATION_STATUS: Record<EvaluationRelation, HypothesisStatus> = {
  supports: "supported",
  contradicts: "refuted",
  inconclusive: "inconclusive",
};

/**
 * Apply an evaluation to its hypothesis, producing the hypothesis in its
 * new standing. Returns a new frozen object; both inputs are untouched.
 *
 * This delegates to the existing `transitionHypothesis` — it never
 * bypasses Phase 1 rules. Consequences, all inherited:
 *
 * - A `candidate` may move to any standing (first evaluation).
 * - Evaluated hypotheses may be re-evaluated as further evidence
 *   arrives (`supported` → `refuted` on a contradicting evaluation, and
 *   back again) — so `supported` means "current standing", never
 *   "proven permanently".
 * - Nothing returns to `candidate`; a refuted hypothesis stays
 *   represented, never deleted.
 *
 * Throws when the evaluation targets a different hypothesis id — an
 * evaluation records ONE pair, and applying it elsewhere would corrupt
 * the record.
 */
export function applyEvaluation(
  hypothesis: Hypothesis,
  evaluation: EvidenceEvaluation,
): Hypothesis {
  if (evaluation.hypothesisId !== hypothesis.id) {
    throw new Error(
      `Evaluation ${JSON.stringify(evaluation.id)} targets hypothesis ` +
        `${JSON.stringify(evaluation.hypothesisId)} and cannot be applied to ` +
        `${JSON.stringify(hypothesis.id)}`,
    );
  }
  return transitionHypothesis(hypothesis, RELATION_STATUS[evaluation.relation]);
}
