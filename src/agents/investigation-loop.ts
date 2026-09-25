import type { Agent } from "./agent.js";
import type { Investigation } from "../investigation/investigation.js";
import type { ExperimentExecutor, ExperimentExecutorSelector } from "./experiment-executor.js";
import type { InvestigationStepResult } from "./investigation-step.js";
import { runInvestigationStep } from "./investigation-step.js";

/**
 * Why the loop stopped. Explicit state, never boolean combinations —
 * callers branch on `stop`:
 *
 * - `finished`: a step returned `finish` (explicitly determined
 *   investigation). Nothing further is requested.
 * - `undetermined`: a step returned `undetermined` (no justified work).
 *   NOT a failure — the domain honestly ran out of decidable work.
 * - `step-failed`: a step returned `step-failed` (`no-evidence` or
 *   `evaluation-failed`). The loop stops instead of retrying; a failed
 *   attempt is not a failed investigation, so status is untouched.
 * - `budget-exhausted`: `maxSteps` iterations ran. A runtime guard
 *   against unbounded execution only — never a semantic conclusion
 *   about the investigation.
 */
export type InvestigationLoopStop = "finished" | "undetermined" | "step-failed" | "budget-exhausted";

/**
 * Everything a bounded run produced: the final snapshot, every step
 * result in order (each carrying its own decided action and, where
 * applicable, its artifacts), and the explicit stop reason.
 */
export interface InvestigationLoopResult {
  readonly investigation: Investigation;
  readonly steps: readonly InvestigationStepResult[];
  readonly stop: InvestigationLoopStop;
}

export interface InvestigationLoopOptions {
  /**
   * Hard bound on step iterations: at most this many
   * `runInvestigationStep()` calls. Must be a non-negative integer;
   * `0` runs nothing and returns the input snapshot untouched.
   */
  readonly maxSteps: number;
  /**
   * Capability performing `run-experiment` actions, threaded through
   * to every step. Injected, never constructed here; required
   * whenever a step decides `run-experiment`, unused otherwise.
   */
  readonly executor?: ExperimentExecutor;
  /**
   * Optional per-experiment capability choice, threaded through to
   * every step alongside `executor`. Same contract as
   * `InvestigationStepOptions.executorForExperiment`: a plain
   * caller-owned function, never a registry, never model-driven.
   */
  readonly executorForExperiment?: ExperimentExecutorSelector;
}

/**
 * Repeat the existing single-step primitive up to `maxSteps` times —
 * the smallest mechanical loop around an already-correct step.
 *
 * State transition per iteration, always from the LATEST snapshot:
 *
 * ```text
 * I0 → decide(I0) → step → I1 → decide(I1) → step → I2 …
 * ```
 *
 * Each iteration calls `runInvestigationStep()` exactly once with the
 * snapshot the previous iteration produced — never the previous
 * action, never a result, never LLM continuation text, never shared
 * mutable state. The loop itself reads no message content at all: it
 * branches only on step `kind`, so no model-generated "continue",
 * "done", or "success" string can steer, prolong, or terminate it.
 *
 * Stopping (checked in this order after each step):
 *
 * 1. `finish` → stop `finished` (zero runs happened inside that step).
 * 2. `undetermined` → stop `undetermined` (zero runs; not a failure).
 * 3. `step-failed` → stop `step-failed` (no retry, no status change).
 * 4. `maxSteps` iterations consumed → stop `budget-exhausted`.
 *
 * Otherwise the step succeeded (`executed` or `experiment-executed`):
 * continue from its new snapshot — so an experiment step producing
 * evidence is naturally followed by an `evaluate-hypothesis` step in
 * a later iteration, never chained inside one step.
 * The input snapshot is never mutated — new frozen snapshots flow
 * forward, and a step that changed nothing preserves identity, which
 * this loop preserves in turn.
 *
 * Lives on the runtime side (`src/agents/`) next to the step it
 * repeats; `src/investigation/` remains runtime-free.
 *
 * Do NOT add retries, scheduling, persistence, hypothesis generation,
 * or any other automation — this is repetition only, no autonomy.
 */
export async function runInvestigationLoop(
  investigation: Investigation,
  agent: Agent,
  options: InvestigationLoopOptions,
): Promise<InvestigationLoopResult> {
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 0) {
    throw new Error(`maxSteps must be a non-negative integer, got ${options.maxSteps}`);
  }
  let current = investigation;
  const steps: InvestigationStepResult[] = [];
  for (let n = 0; n < options.maxSteps; n++) {
    const step = await runInvestigationStep(current, agent, { executor: options.executor, executorForExperiment: options.executorForExperiment });
    steps.push(step);
    if (step.kind === "finish") {
      return { investigation: current, steps: Object.freeze(steps), stop: "finished" };
    }
    if (step.kind === "undetermined") {
      return { investigation: current, steps: Object.freeze(steps), stop: "undetermined" };
    }
    if (step.kind === "step-failed") {
      return { investigation: step.investigation, steps: Object.freeze(steps), stop: "step-failed" };
    }
    current = step.investigation;
  }
  return { investigation: current, steps: Object.freeze(steps), stop: "budget-exhausted" };
}
