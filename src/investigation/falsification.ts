import { randomUUID } from "node:crypto";

/**
 * A falsification criterion: a specification of what concrete
 * observation would count as disconfirming evidence for one hypothesis.
 *
 * What it is NOT, by design:
 *
 * - NOT evidence: stating "if X occurs, the hypothesis is contradicted"
 *   observes nothing. A criterion records what to look for; only future
 *   observation/evidence, evaluated against the hypothesis, can affect
 *   its standing.
 * - NOT an experiment result: no execution happens here.
 * - NOT a hypothesis status: creating a criterion neither refutes the
 *   hypothesis nor implies it is currently false.
 *
 * The criterion is a plain operational string ("If an already-accepted
 * action executes after generation rotation, this hypothesis is
 * false") — concrete enough that a future agent/runtime could attempt
 * to test it, but deliberately NOT a formal predicate language: no mini
 * language, no expression evaluator until a concrete requirement exists.
 *
 * Immutable value object, frozen at creation. References its hypothesis
 * by plain id (never the `Hypothesis` object) — following the same
 * ID-based relationship pattern as `EvidenceEvaluation` — so there are
 * no duplicated states, no circular references, and no accidental
 * mutation. Several criteria may reference the same hypothesis: a
 * hypothesis can be falsifiable in more than one way, and nothing here
 * enforces one-to-one.
 *
 * Do NOT add experiments, tool execution, status derivation, automatic
 * refutation, confidence scores, or model revision here — those belong
 * to later phases.
 */
export interface Falsification {
  readonly id: string;
  readonly hypothesisId: string;
  readonly criterion: string;
}

/**
 * Seal a fresh falsification criterion for one hypothesis. `id`
 * defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known criterion. Identity and criterion must be
 * non-empty — never a sentinel, never a vague placeholder: an empty
 * criterion specifies nothing to look for.
 */
export function createFalsification(
  hypothesisId: string,
  criterion: string,
  id: string = randomUUID(),
): Falsification {
  if (id.trim() === "") {
    throw new Error("Falsification id must be a non-empty string");
  }
  if (hypothesisId.trim() === "") {
    throw new Error("Falsification hypothesisId must be a non-empty string");
  }
  if (criterion.trim() === "") {
    throw new Error("Falsification criterion must be a non-empty string");
  }
  return Object.freeze({ id, hypothesisId, criterion });
}
