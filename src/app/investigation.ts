import type { Agent } from "../agents/agent.js";
import type { LLMClient } from "../llm/client.js";
import { authorHypothesis } from "../agents/hypothesis-authoring.js";
import { HttpStatusExperimentExecutor } from "../agents/http-status-executor.js";
import type { InvestigationLoopResult } from "../agents/investigation-loop.js";
import { runInvestigationLoop } from "../agents/investigation-loop.js";
import { createGoal } from "../investigation/goal.js";
import { createExperiment } from "../investigation/experiment.js";
import {
  addExperiment,
  createInvestigation,
} from "../investigation/investigation.js";

export interface AppInvestigationConfig {
  /**
   * Target probed by the investigation's HTTP executor. Owned by
   * application configuration (caller-supplied, e.g. environment) —
   * never by model output, experiment prose, or user chat text.
   * Must be an `http:`/`https:` URL; validated fail-fast by the
   * executor constructor below.
   */
  readonly httpTarget: string;
  /**
   * Bound on loop iterations, owned by the application. Required —
   * following `runInvestigationLoop`, which takes no default so no
   * call site runs unbounded by accident.
   */
  readonly maxSteps: number;
  /**
   * Second probed target, for the dependency experiment below. Same
   * ownership and validation as `httpTarget`: application
   * configuration only, never model output or experiment prose.
   * A second configured value — not a registry, not a selection
   * system; each experiment below names exactly one of the two.
   */
  readonly dependencyHttpTarget: string;
  /**
   * HTTP implementation for the executors, defaulting to the global
   * `fetch`. Threaded through (not constructed here) solely so tests
   * can stub the network boundary; production callers omit it.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * One complete application-level investigation, composed from existing
 * domain/runtime primitives — composition and sequencing only, no new
 * framework, no service object, no registry:
 *
 * 1. `Goal` from the supplied request (intent, nothing more).
 * 2. `authorHypothesis()` — the model proposes exactly one candidate;
 *    the strict parser + domain factory admit nothing else.
 * 3. Exactly two application-owned `Experiment`s targeting the authored
 *    hypothesis: a primary probe and a dependency probe. The procedures
 *    below are deployer-written descriptive text kept physically
 *    adjacent to the executor constructions using them — they are never
 *    parsed, never executed, never sourced from the model.
 * 4. One `HttpStatusExperimentExecutor` per configured target, built
 *    from `config.httpTarget` / `config.dependencyHttpTarget`
 *    (constructed before any LLM call, so an invalid target fails
 *    fast without spending model output). Each executor alone owns
 *    its target and alone mints `tool-result` observations; a closed
 *    per-experiment mapping below decides which instance runs which
 *    experiment — a fixed two-branch application policy, not a
 *    registry, never model-driven.
 * 5. `runInvestigationLoop()` with the caller-supplied evaluation
 *    `agent` — existing agents evaluate unmodified.
 *
 * Authority map, enforced by construction rather than convention:
 * LLM → hypothesis text + evaluation prose only; application →
 * experiment, target, budget, sequencing; executor → observation
 * provenance; domain → standing, lineage, snapshots. In particular
 * model output can never select the HTTP target, choose an executor,
 * or mint non-assertion provenance: no value flows from any LLM
 * response into executor configuration or procedure.
 *
 * Returns the loop's `InvestigationLoopResult` unchanged — callers
 * branch on its existing `stop` discriminant. The TUI is not involved
 * here and gains no domain imports from this module existing.
 *
 * Do NOT extend this function with UI commands, progress events,
 * persistence, retries, additional experiments, or executor
 * selection — each of those is a separate architectural decision.
 */
export async function runAppInvestigation(
  llm: LLMClient,
  agent: Agent,
  input: string,
  config: AppInvestigationConfig,
): Promise<InvestigationLoopResult> {
  const primaryExecutor = new HttpStatusExperimentExecutor({
    url: config.httpTarget,
    fetchImpl: config.fetchImpl,
  });
  const dependencyExecutor = new HttpStatusExperimentExecutor({
    url: config.dependencyHttpTarget,
    fetchImpl: config.fetchImpl,
  });
  let investigation = createInvestigation(createGoal(input));
  investigation = await authorHypothesis(llm, investigation, input);
  const hypothesis = investigation.hypotheses[0];
  if (hypothesis === undefined) {
    throw new Error("Authoring produced no candidate hypothesis");
  }
  // Application-owned procedures, adjacent to the executor
  // constructions above by design (see Phase 33/34 authority
  // boundary): descriptive intent only — no executor reads them.
  // Insertion order is the execution order, and no selection
  // intelligence exists or is needed.
  const primaryExperiment = createExperiment(
    hypothesis.id,
    "Observe the primary service HTTP status and record the response status.",
  );
  const dependencyExperiment = createExperiment(
    hypothesis.id,
    "Observe the dependency service HTTP status and record the response status.",
  );
  investigation = addExperiment(
    addExperiment(investigation, primaryExperiment),
    dependencyExperiment,
  );
  // Closed per-experiment mapping over the two instances just built:
  // fixed application policy (this composition owns both sides), not
  // a registry, never model output. Unknown ids fail fast rather than
  // silently defaulting to either target.
  const executorForExperiment = (experimentId: string) => {
    if (experimentId === dependencyExperiment.id) {
      return dependencyExecutor;
    }
    if (experimentId === primaryExperiment.id) {
      return primaryExecutor;
    }
    throw new Error(`No executor configured for experiment ${JSON.stringify(experimentId)}`);
  };
  return runInvestigationLoop(investigation, agent, {
    maxSteps: config.maxSteps,
    executor: primaryExecutor,
    executorForExperiment,
  });
}
