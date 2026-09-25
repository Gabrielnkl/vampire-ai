import { randomUUID } from "node:crypto";

/**
 * A statement that should remain true across relevant system states
 * (e.g. "every settled result carries a distinct id").
 *
 * Pure data in this phase: identity plus the statement, frozen at
 * creation. There is deliberately NO automatic checking here — an
 * invariant records what must hold, never whether it currently holds.
 * Checking belongs to a later phase.
 *
 * Do NOT add speculative fields (scope predicates, checkers, severity,
 * violations) until a concrete requirement exists.
 */
export interface Invariant {
  readonly id: string;
  readonly statement: string;
}

/**
 * Seal a freshly stated invariant. `id` defaults to a fresh UUID; pass
 * an explicit id in tests and when rehydrating a known invariant.
 */
export function createInvariant(statement: string, id: string = randomUUID()): Invariant {
  if (id.trim() === "") {
    throw new Error("Invariant id must be a non-empty string");
  }
  if (statement.trim() === "") {
    throw new Error("Invariant statement must be a non-empty string");
  }
  return Object.freeze({ id, statement });
}
