import { randomUUID } from "node:crypto";

/**
 * What an investigation is trying to understand or accomplish.
 *
 * Immutable value object (see `createGoal`): identity plus a description
 * of the goal, frozen at creation. A goal describes intent — it never
 * records conclusions, so reaching or abandoning it is tracked on the
 * `Investigation` status, never by mutating the goal.
 *
 * Do NOT add speculative fields (priorities, owners, deadlines,
 * acceptance criteria, metadata) until a concrete requirement exists.
 */
export interface Goal {
  readonly id: string;
  readonly description: string;
}

/**
 * Seal a freshly stated goal. `id` defaults to a fresh UUID so every
 * goal has a stable identity; pass an explicit id in tests and when
 * rehydrating a known goal. Both fields must be non-empty — never a
 * sentinel (`""`, `"none"`, …).
 */
export function createGoal(description: string, id: string = randomUUID()): Goal {
  if (id.trim() === "") {
    throw new Error("Goal id must be a non-empty string");
  }
  if (description.trim() === "") {
    throw new Error("Goal description must be a non-empty string");
  }
  return Object.freeze({ id, description });
}
