import { randomUUID } from "node:crypto";

/**
 * A concrete proposed procedure for producing an observation relevant
 * to a hypothesis — a plan/description only.
 *
 * What it is NOT, by design:
 *
 * - NOT execution: describing "submit the stale snapshot and record
 *   accept/reject" submits nothing. No executor, tool, command,
 *   timeout, or retry lives here or is referenced here.
 * - NOT a verdict: the procedure says what to do, never what the
 *   outcome means. It contains no supports/contradicts, no
 *   success/failure, no standing — recording what to look for decides
 *   nothing, exactly as a `Falsification` criterion decides nothing.
 * - NOT evidence, observation, or evaluation: creating an experiment
 *   produces none of these and alters no hypothesis standing and no
 *   investigation status.
 *
 * `hypothesisId` identifies the hypothesis under investigation.
 * `falsificationId` optionally identifies the falsification criterion
 * the procedure is designed to test; `null` marks exploratory work not
 * yet tied to a criterion. Both are plain ids (never embedded
 * objects), following the same ID-reference pattern as
 * `EvidenceEvaluation` and `Falsification`.
 *
 * `procedure` is descriptive plain language, concrete enough that a
 * future executor could attempt it — but deliberately NOT a mini
 * programming language: nothing interprets or executes it, now or
 * here.
 *
 * Immutable value object, frozen at creation. Several experiments may
 * target the same hypothesis: there can be more than one way to probe
 * an explanation, and nothing here enforces one-to-one.
 *
 * Do NOT add expected results, confidence, priority, executors, tools,
 * commands, timeouts, retries, statuses, results, observations,
 * evidence, or evaluations — those belong to later phases, if at all.
 */
export interface Experiment {
  readonly id: string;
  readonly hypothesisId: string;
  readonly falsificationId: string | null;
  readonly procedure: string;
}

export interface ExperimentOptions {
  readonly falsificationId?: string | null;
  readonly id?: string;
}

/**
 * Seal a fresh experiment plan for one hypothesis. `id` defaults to a
 * fresh UUID and `falsificationId` defaults to `null` (exploratory);
 * pass explicit values in tests and when rehydrating a known
 * experiment. Identity, hypothesis, and procedure must be non-empty —
 * never a sentinel: an empty procedure describes nothing to do. A
 * present `falsificationId` must likewise be non-empty.
 */
export function createExperiment(
  hypothesisId: string,
  procedure: string,
  options: ExperimentOptions = {},
): Experiment {
  const id = options.id ?? randomUUID();
  if (id.trim() === "") {
    throw new Error("Experiment id must be a non-empty string");
  }
  if (hypothesisId.trim() === "") {
    throw new Error("Experiment hypothesisId must be a non-empty string");
  }
  if (procedure.trim() === "") {
    throw new Error("Experiment procedure must be a non-empty string");
  }
  const falsificationId = options.falsificationId ?? null;
  if (falsificationId !== null && falsificationId.trim() === "") {
    throw new Error("Experiment falsificationId must be a non-empty string when present");
  }
  return Object.freeze({ id, hypothesisId, falsificationId, procedure });
}
