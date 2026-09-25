import type { Experiment } from "../investigation/experiment.js";
import type { Observation } from "../investigation/observation.js";

/**
 * The only boundary that may turn an experiment plan into an
 * observation. An implementation performs real work through its own
 * capability and returns what it actually observed — nothing more.
 *
 * Deliberately minimal: one method, no policy. It must NOT contain
 * retry policy, scheduling, persistence, status, evaluation, evidence
 * creation, hypothesis mutation, planner behavior, or action dispatch.
 * The executor performs work and returns an `Observation`; it does not
 * decide whether the experiment was useful, what the observation means,
 * or what happens next.
 *
 * Provenance trust rule — the load-bearing invariant of this
 * interface: the returned observation's `source` must describe what
 * actually produced it, not what any model claimed happened. Only a
 * real executor may produce an observation carrying non-assertion
 * provenance (`test-result`, `tool-result`, `runtime-event`): the
 * implementation, not the procedure text, is the trust root for those
 * kinds. An implementation backed only by model text may mint solely
 * `agent-assertion` observations. Minting `test-result` for an
 * LLM-generated claim no test performed is a provenance fraud this
 * architecture exists to prevent.
 *
 * This is capability execution, not text generation: implementations
 * must NOT call `Agent.run()` (or modify `Agent`, `SingleAgent`,
 * `MultiAgent`, `Planner`, `LLMClient`) to "perform" experiments. The
 * agent abstraction produces text; experiment execution performs work.
 * Keep the authorities separate.
 *
 * Lives in `src/agents/` alongside the other runtime-side adapters: a
 * single interface does not justify a new top-level area. Production
 * fakes do not belong here — tests define local deterministic
 * implementations following the existing `FakeLLM` convention.
 */
export interface ExperimentExecutor {
  execute(experiment: Experiment): Promise<Observation>;
}

/**
 * Caller-supplied mapping from experiment id to the trusted capability
 * that runs it. This is application policy, not a registry: a plain
 * function the caller already owns (typically a closed-over comparison
 * against known experiment ids), with no storage, no registration, no
 * dynamic discovery, and no model input. Unknown ids should throw
 * fail-fast rather than silently default, so misrouting is a loud
 * programmer error, never a quiet wrong-target execution.
 */
export type ExperimentExecutorSelector = (experimentId: string) => ExperimentExecutor;
