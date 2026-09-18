import type { Message } from "../chat/message.js";

/**
 * What an agent produced for its parent — as opposed to `AgentEvent`,
 * which describes what happened while it was running (for UI rendering
 * and observability).
 *
 * Structurally readonly: the id, producer name, messages array, and each
 * message are all immutable through the typed boundary, and the same
 * result object may be safely shared across child contexts. Runtime
 * freezing (see `freezeResult`) backs this for genuinely adversarial JS;
 * the types alone stop ordinary mistakes.
 *
 * `id` identifies WHICH execution produced the result: every `run()` call
 * mints a fresh UUID at start, so two runs of the same agent never share
 * an id — even for empty or failed results, which still represent an
 * execution. Never a sentinel (`""`, `"none"`, …).
 *
 * `agent` is authoritative producer metadata: it always comes from the
 * `Agent` that settled the result (`descriptor.name`), never from the
 * planner, plan position, streamed events, or inferred ordering. It is
 * descriptive only — never a routing instruction. No agent can cause
 * another agent to execute by returning a name.
 *
 * Deliberately minimal: identity, producer, plus the assistant messages
 * to publish into the parent conversation. Do NOT add speculative fields
 * (tool calls, artifacts, metadata, costs, plans) until an actual
 * requirement exists.
 *
 * Rule: partial streamed output is an execution detail, never a
 * published result. Failed or empty executions resolve to an empty
 * `messages` list that still carries id and producer.
 */
export interface AgentResult {
  readonly id: string;
  readonly agent: string;
  readonly messages: readonly Message[];
}

/**
 * Seal a freshly built result before publishing it: freezes the result
 * object, the messages array, and each message. Local to this boundary —
 * not a generic deep-freeze utility. Callers must pass arrays they own
 * (fresh literals or locally accumulated lists), since freezing is
 * in place. `id` must be freshly minted per execution; `agent` must be
 * the settling producer's own descriptor name.
 */
export function freezeResult(
  id: string,
  agent: string,
  messages: readonly Message[],
): AgentResult {
  for (const message of messages) {
    Object.freeze(message);
  }
  return Object.freeze({ id, agent, messages: Object.freeze(messages) });
}
