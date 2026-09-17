import type { Message } from "../chat/message.js";

/**
 * What an agent produced for its parent — as opposed to `AgentEvent`,
 * which describes what happened while it was running (for UI rendering
 * and observability).
 *
 * Deliberately minimal: the assistant messages to publish into the
 * parent conversation. Do NOT add speculative fields (tool calls,
 * artifacts, metadata, costs, plans) until an actual requirement exists.
 *
 * Rule: partial streamed output is an execution detail, never a
 * published result. Failed or empty executions resolve to
 * `{ messages: [] }`.
 */
export interface AgentResult {
  messages: Message[];
}
