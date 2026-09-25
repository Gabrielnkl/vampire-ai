import type { Evidence } from "../investigation/evidence.js";
import { createEvidence } from "../investigation/evidence.js";
import type { Observation } from "../investigation/observation.js";

/**
 * Explicit promotion of an observation into evidence — the runtime-side
 * adapter analogous to `agentResultToEvidence`, for material that was
 * observed rather than generated.
 *
 * Preserves `observation.content` and `observation.source` exactly: a
 * `test-result` observation becomes `test-result` evidence, never
 * rewritten into (or out of) `agent-assertion`. The adapter adds no
 * verdict, evaluates nothing, links no hypotheses (`hypothesisIds`
 * stays empty — linkage is a separate deliberate step), mutates
 * nothing, and changes no standing or status.
 *
 * This is explicit or nothing: observations never become evidence by
 * themselves (see `createObservation`, which creates no evidence, and
 * `addEvidence`, which only stores what it is given). Callers invoke
 * this promotion deliberately, per observation they choose to retain
 * for reasoning.
 *
 * `id` defaults to a fresh evidence UUID (independent identity domain
 * from the observation, matching the `AgentResult` → `Evidence`
 * precedent); pass an explicit id in tests and when rehydrating known
 * evidence.
 *
 * Lives in `src/agents/` next to the other adapters so
 * `src/investigation/` keeps importing nothing from the runtime.
 *
 * Do NOT extend this adapter with automatic promotion, evaluation,
 * status derivation, or invocation from constructors or aggregate
 * operations — those belong to later phases, if at all.
 */
export function observationToEvidence(
  observation: Observation,
  options: { id?: string } = {},
): Evidence {
  return createEvidence(observation.content, { ...observation.source }, options);
}
