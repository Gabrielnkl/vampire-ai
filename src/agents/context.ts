import type { Conversation } from "../chat/conversation.js";
import type { AgentResult } from "./result.js";

/**
 * Execution-scoped state handed to an `Agent` on each run.
 *
 * `conversation` is the agent's isolated working conversation.
 * `previousResults` carries the settled results of earlier completed
 * agents in the same plan, oldest first — read-only, one-way data flow
 * with no agent-to-agent coupling. Result objects are shared by reference
 * and treated as immutable by convention; each context gets its own array.
 *
 * Deliberately minimal: only what the current system genuinely requires.
 * Do NOT add speculative fields (IDs, tools, cancellation, logging,
 * tracing, metadata, memory, model config) until a concrete requirement
 * exists.
 */
export interface AgentContext {
  readonly conversation: Conversation;
  readonly previousResults: readonly AgentResult[];
}

/**
 * Derive an isolated working context from a parent context.
 *
 * The child gets its own `Conversation` object preloaded with the
 * parent's current messages — never the parent's mutable instance, so
 * neither side's later `add()` calls affect the other — plus a fresh copy
 * of the parent's results array, so later appends to either side stay
 * independent. There is no generic cloning machinery: explicit fields,
 * explicit copies.
 */
export function forkContext(parent: AgentContext): AgentContext {
  return {
    conversation: parent.conversation.clone(),
    previousResults: [...parent.previousResults],
  };
}
