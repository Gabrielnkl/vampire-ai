import { randomUUID } from "node:crypto";

/**
 * The outcome of checking one invariant against specific evidence:
 *
 * - `holds`: the cited evidence is sufficient to establish that the
 *   invariant holds for the checked situation.
 * - `violated`: the cited evidence demonstrates that the invariant does
 *   not hold for the checked situation.
 * - `unknown`: the cited evidence is insufficient to determine either
 *   way. `unknown` is its own standing — never read it as `holds` and
 *   never read it as `violated`.
 *
 * Do NOT add speculative results (partial holds, severities, confidence)
 * until a concrete requirement exists.
 */
export type InvariantCheckResult = "holds" | "violated" | "unknown";

/**
 * One checking of an invariant against evidence — as opposed to the
 * `Invariant` itself, which only states a property that should hold and
 * deliberately carries no verdict.
 *
 * Why the check is separate: the same invariant is checked repeatedly as
 * new evidence arrives, and different checks may disagree (check #1
 * `holds` on "one pending action", check #2 `violated` on "two pending
 * actions") while the invariant itself never changes. Putting `holds` /
 * `violated` on `Invariant` would collapse "should hold" and "did hold
 * here" into one field and make repeated checking unrepresentable.
 *
 * Structurally analogous to `EvidenceEvaluation` (interpretation of
 * evidence relative to one domain object, referenced by plain ids, never
 * embedded objects) but semantically distinct — and therefore a separate
 * type, not a reuse:
 *
 * - Hypothesis + Evaluation asks: "Is this explanation supported?"
 * - Invariant + Check asks: "Does this required property hold?"
 *
 * A `violated` result is evidence about the system, not a causal
 * explanation: it refutes no hypothesis and fails no investigation by
 * itself. Those consequences, if ever wanted, belong to later phases —
 * nothing here derives them.
 *
 * `reasoning` records WHY the cited evidence establishes the result, so
 * the runtime can later inspect the explanation. It is an explanation,
 * not additional evidence and not authoritative truth. No LLM
 * provenance: the existing architecture requires no producer tracking
 * for this record.
 *
 * Immutable value object, frozen at creation. References its invariant
 * and evidence by plain ids so checking never requires — and never
 * mutates — the checked members.
 *
 * Do NOT add runtime monitoring, automatic checking, status derivation,
 * or model revision here — those belong to later phases.
 */
export interface InvariantCheck {
  readonly id: string;
  readonly invariantId: string;
  readonly evidenceIds: readonly string[];
  readonly result: InvariantCheckResult;
  readonly reasoning: string;
}

function assertValidResult(result: InvariantCheckResult): void {
  if (result !== "holds" && result !== "violated" && result !== "unknown") {
    throw new Error(`Invalid invariant check result: ${JSON.stringify(result)}`);
  }
}

/**
 * Seal a fresh check of one invariant against the cited evidence.
 * `id` defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known check.
 *
 * At least one evidence id is required: a check interprets evidence, so
 * a check citing nothing interprets nothing — "unknown with no
 * evidence" adds no information beyond the absence of a check. Every
 * cited id must be non-empty.
 */
export function createInvariantCheck(
  invariantId: string,
  evidenceIds: readonly string[],
  result: InvariantCheckResult,
  reasoning: string,
  id: string = randomUUID(),
): InvariantCheck {
  if (id.trim() === "") {
    throw new Error("InvariantCheck id must be a non-empty string");
  }
  if (invariantId.trim() === "") {
    throw new Error("InvariantCheck invariantId must be a non-empty string");
  }
  if (evidenceIds.length === 0) {
    throw new Error("InvariantCheck requires at least one evidence id");
  }
  for (const evidenceId of evidenceIds) {
    if (evidenceId.trim() === "") {
      throw new Error("InvariantCheck evidenceIds must not contain empty ids");
    }
  }
  assertValidResult(result);
  if (reasoning.trim() === "") {
    throw new Error("InvariantCheck reasoning must be a non-empty string");
  }
  return Object.freeze({
    id,
    invariantId,
    evidenceIds: Object.freeze([...evidenceIds]),
    result,
    reasoning,
  });
}
