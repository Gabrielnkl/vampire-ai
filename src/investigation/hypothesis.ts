import { randomUUID } from "node:crypto";

/**
 * Lifecycle of a candidate explanation:
 *
 * - `candidate`: proposed, not yet evaluated. Every hypothesis starts
 *   here — including ones proposed by an LLM. Proposal is not knowledge.
 * - `supported`: current evidence speaks for it (a standing assessment,
 *   not a proof — new evidence can still overturn it).
 * - `refuted`: current evidence speaks against it. Refuted hypotheses
 *   are kept, never deleted: being wrong is part of the record.
 * - `inconclusive`: evaluated, but the evidence does not settle it
 *   either way.
 *
 * Do NOT add speculative states (probabilities, confidence levels,
 * priorities) until a concrete requirement exists.
 */
export type HypothesisStatus = "candidate" | "supported" | "refuted" | "inconclusive";

/**
 * A candidate explanation under investigation.
 *
 * Immutable value object: status changes produce a new frozen object via
 * `transitionHypothesis`, so a hypothesis observed before evaluation and
 * the same hypothesis after evaluation are both representable — in
 * particular a refuted hypothesis remains a first-class value, never
 * removed or rewritten into a success.
 */
export interface Hypothesis {
  readonly id: string;
  readonly statement: string;
  readonly status: HypothesisStatus;
}

/**
 * Seal a freshly proposed hypothesis. Always starts as `candidate`:
 * whoever proposed it (LLM, tool, user) does not determine its standing.
 * `id` defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known hypothesis.
 */
export function createHypothesis(statement: string, id: string = randomUUID()): Hypothesis {
  if (id.trim() === "") {
    throw new Error("Hypothesis id must be a non-empty string");
  }
  if (statement.trim() === "") {
    throw new Error("Hypothesis statement must be a non-empty string");
  }
  return Object.freeze({ id, statement, status: "candidate" as const });
}

/**
 * Which statuses may follow the current one. `candidate` may be
 * evaluated into any terminal-of-this-round state; evaluated hypotheses
 * may be re-evaluated among `supported` / `refuted` / `inconclusive` as
 * new evidence arrives. Nothing returns to `candidate` — "never
 * evaluated" cannot become true again — and same-state transitions are
 * accepted as no-ops so re-applying the current assessment is harmless.
 */
const ALLOWED_TRANSITIONS: Record<HypothesisStatus, readonly HypothesisStatus[]> = {
  candidate: ["candidate", "supported", "refuted", "inconclusive"],
  supported: ["supported", "refuted", "inconclusive"],
  refuted: ["refuted", "supported", "inconclusive"],
  inconclusive: ["inconclusive", "supported", "refuted"],
};

/**
 * Move a hypothesis to a new lifecycle state. Returns a new frozen
 * object; the input is untouched, so the pre-transition value stays
 * representable. Throws on transitions outside
 * `ALLOWED_TRANSITIONS` (notably anything back to `candidate`).
 */
export function transitionHypothesis(
  hypothesis: Hypothesis,
  next: HypothesisStatus,
): Hypothesis {
  if (!(ALLOWED_TRANSITIONS[hypothesis.status] as readonly string[]).includes(next)) {
    throw new Error(
      `Invalid hypothesis transition: ${JSON.stringify(hypothesis.status)} -> ${JSON.stringify(next)}`,
    );
  }
  return Object.freeze({ ...hypothesis, status: next });
}
