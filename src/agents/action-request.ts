import { Conversation } from "../chat/conversation.js";
import type { Investigation } from "../investigation/investigation.js";
import type { InvestigationAction } from "../investigation/action.js";
import type { AgentContext } from "./context.js";

/**
 * The parameters of one existing agent execution: the input an `Agent`
 * would receive plus the context it would run in. This is deliberately
 * NOT a new type — it is exactly the `(input, context)` pair of the
 * existing `Agent.run(input, context)` signature, bundled as data so it
 * can be built without executing anything.
 */
export interface AgentRunRequest {
  readonly input: string;
  readonly context: AgentContext;
}

/**
 * Pure adapter from an investigation decision to the existing agent
 * runtime — the second half of the bridge whose first half is
 * `agentResultToEvidence` (which stays the single `AgentResult` →
 * `Evidence` conversion; nothing here duplicates it).
 *
 * Lives on the runtime side of the boundary (`src/agents/`, next to
 * `result-evidence.ts`) — NOT in `src/investigation/` — so the
 * investigation domain keeps importing nothing from the runtime. Only
 * this adapter imports from both.
 *
 * Mapping, per action kind:
 *
 * - `finish` → `null`. The investigation already has a determined
 *   terminal status; that status is authoritative. There is nothing to
 *   execute, and reinterpreting `finish` as "ask the agent for the
 *   final answer" would second-guess the determination.
 * - `undetermined` → `null`. The domain could not justify an execution
 *   step, so none is manufactured — in particular there is NO
 *   "ask the LLM what to do" fallback. Uncertainty stays explicit;
 *   `null` means "no executable action", never "try anything".
 * - `run-experiment` → `null`. Experiment execution is capability
 *   work for an `ExperimentExecutor`, never agent text generation:
 *   this adapter builds `Agent.run()` requests only, so it requests
 *   nothing here. (The step routes `run-experiment` to the executor
 *   before consulting this adapter.)
 * - `evaluate-hypothesis` → an `AgentRunRequest` whose `input` asks the
 *   agent to assess the named hypothesis against the selected
 *   evidence only (one explicit pair — never a free choice among the
 *   record), with a fresh isolated `AgentContext` (empty
 *   `Conversation`, no `previousResults`). Hypothesis and evidence are
 *   resolved from the given snapshot by id; unknown ids throw
 *   fail-fast, matching `updateHypothesis`. The hypothesis-only action
 *   proved sufficient in earlier phases; the action now names its
 *   evidence too, so no selection is left to the agent.
 *
 * What this adapter NEVER does (the stages stay distinct):
 *
 * - It never calls `Agent.run` or touches `MultiAgent` / `Planner` —
 *   building the request IS the whole job; execution belongs to a
 *   later phase. Stopping at the request (or at `null`) leaves a
 *   completely valid system state.
 * - It never creates `Evidence` — only a later `AgentResult`, via
 *   `agentResultToEvidence`, can become evidence.
 * - It never evaluates: the agent's prose output will be an
 *   `agent-assertion` like any other, and only an explicit future
 *   `EvidenceEvaluation` can move hypothesis standing.
 * - It never declares hypotheses supported/refuted/inconclusive and
 *   never declares the investigation succeeded/failed.
 * - It mutates nothing: the snapshot, its members, and the runtime
 *   (no shared `Conversation`, no shared result arrays) are untouched.
 *   Evidence reaches the prompt as copied strings only — no domain
 *   object is placed into mutable runtime state.
 *
 * Do NOT extend this adapter with loops, retries, automatic follow-up
 * actions, or status derivation — those belong to later phases.
 */
export function investigationActionToRequest(
  action: InvestigationAction,
  investigation: Investigation,
): AgentRunRequest | null {
  switch (action.kind) {
    case "finish":
      return null;
    case "undetermined":
      return null;
    case "run-experiment":
      return null;
    case "evaluate-hypothesis": {
      const hypothesis = investigation.hypotheses.find((h) => h.id === action.hypothesisId);
      if (hypothesis === undefined) {
        throw new Error(`Unknown hypothesis id: ${JSON.stringify(action.hypothesisId)}`);
      }
      const evidence = investigation.evidence.find((e) => e.id === action.evidenceId);
      if (evidence === undefined) {
        throw new Error(`Unknown evidence id: ${JSON.stringify(action.evidenceId)}`);
      }
      // The prompt states the exact output contract expected by
      // `agentResultToEvaluation()`: four lines naming this exact
      // pair, no prose around them. Only the selected evidence is
      // presented — the agent evaluates one explicit (Evidence,
      // Hypothesis) pair, never a free choice among the record. The
      // domain parser is deliberately strict, so the contract lives
      // here at the runtime boundary — the domain never learns to read
      // free-form output.
      const input =
        `Assess the following hypothesis against the following evidence.\n\n` +
        `Hypothesis (${hypothesis.id}):\n${hypothesis.statement}\n\n` +
        `Evidence (${evidence.id}):\n${evidence.content}\n\n` +
        `Respond with exactly these four lines and nothing else.\n` +
        `Evidence: ${evidence.id}\n` +
        `Hypothesis: ${hypothesis.id}\n` +
        `Relation: supports | contradicts | inconclusive\n` +
        `Reasoning: <one-line explanation of why the evidence stands in that relation to the hypothesis>`;
      return {
        input,
        context: { conversation: new Conversation(), previousResults: [] },
      };
    }
  }
}
