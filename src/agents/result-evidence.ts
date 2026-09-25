import type { AgentResult } from "./result.js";
import type { Evidence } from "../investigation/evidence.js";
import { createEvidence } from "../investigation/evidence.js";

/**
 * Pure adapter from an agent execution result to investigation evidence.
 *
 * Lives on the agent side of the boundary (`src/agents/`, next to
 * `AgentResult`) — NOT in `src/investigation/` — so the investigation
 * domain stays independent of agent execution: the domain imports
 * nothing from the runtime, and only this adapter imports from both.
 * Nothing here executes, plans, evaluates, or publishes; callers invoke
 * the conversion explicitly. In particular `AgentRun` and `MultiAgent`
 * never call this — there is no automatic execution-to-investigation
 * flow yet.
 *
 * Semantic boundary (structural, not just documentary):
 *
 * - An `AgentResult` records WHAT an execution produced
 *   (`messages`) and WHO produced it (`agent`). It carries no success
 *   flag: a settled result with messages means the execution produced
 *   output, and an empty `messages` list means it produced nothing
 *   (failure or empty response — the two are indistinguishable here, and
 *   deliberately so: partial streamed output is never a result).
 * - The resulting `Evidence` records the same output as
 *   agent-produced information (`agent-assertion` provenance carrying
 *   the originating `result.agent` name). It claims nothing about truth:
 *   "X causes Y" from an agent stays an agent assertion, never a
 *   verified finding.
 *
 * Therefore converting a result NEVER:
 *
 * - attaches the evidence to a hypothesis (`hypothesisIds` is empty),
 * - evaluates or supports any hypothesis,
 * - changes any `Investigation` status.
 *
 * A non-empty result converts to exactly one `Evidence`. An empty
 * result converts to `null` — there is no claim to record, and
 * `Evidence` requires non-empty content, so inventing content (or
 * evidence-about-failure) would fabricate what the execution never
 * said. Callers treat `null` as "this execution contributed no
 * evidence".
 *
 * Identity note: the evidence gets its own fresh id (independent
 * investigation-domain identity), never the result's execution id —
 * `AgentResult.id` identifies WHICH execution ran, `Evidence.id`
 * identifies a piece of the investigation record. The "where did this
 * come from" answer is the provenance (`agent`), not a shared id.
 *
 * Do NOT extend this adapter with hypothesis evaluation, falsification,
 * status derivation, or automatic invocation from the runtime — those
 * belong to later phases.
 */
export function agentResultToEvidence(
  result: AgentResult,
  options: { id?: string } = {},
): Evidence | null {
  const content = result.messages.map((message) => message.content).join("\n");
  if (content.trim() === "") {
    return null;
  }
  return createEvidence(content, { kind: "agent-assertion", agent: result.agent }, options);
}
