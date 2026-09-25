import { randomUUID } from "node:crypto";
import type { Experiment } from "../investigation/experiment.js";
import type { ExperimentExecution } from "../investigation/experiment-execution.js";
import type { Observation } from "../investigation/observation.js";

/**
 * Seal a fresh experiment-execution record from the two members it
 * links — the runtime-side factory for the pure `ExperimentExecution`
 * shape in `src/investigation/experiment-execution.ts`.
 *
 * Lives here (`src/agents/`, next to the executor interface) — NOT in
 * `src/investigation/` — following the `ExecutionRecord` split: the
 * domain holds the dependency-free shape, the runtime side seals it
 * from member objects. Members are read, never mutated and never
 * stored: only their ids enter the record.
 *
 * Sealing a record executes nothing, evaluates nothing, and changes no
 * standing or status anywhere. It records that an execution happened,
 * not what its observation means.
 *
 * `id` defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known record.
 *
 * Do NOT extend this factory with verdicts, standings, evidence links,
 * loops, retries, or automatic follow-ups — those belong to later
 * phases, if at all.
 */
export function createExperimentExecution(
  experiment: Experiment,
  observation: Observation,
  id: string = randomUUID(),
): ExperimentExecution {
  if (id.trim() === "") {
    throw new Error("ExperimentExecution id must be a non-empty string");
  }
  if (experiment.id.trim() === "") {
    throw new Error("ExperimentExecution requires an experiment with a non-empty id");
  }
  if (observation.id.trim() === "") {
    throw new Error("ExperimentExecution requires an observation with a non-empty id");
  }
  return Object.freeze({
    id,
    experimentId: experiment.id,
    observationId: observation.id,
  });
}
