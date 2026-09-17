import type { Message } from "../chat/message.js";
import type { AgentDescriptor } from "./descriptor.js";

/**
 * Everything a planner may consider: the current user input, a
 * point-in-time snapshot of the conversation history, and the available
 * agents described as data.
 *
 * All fields are explicitly readonly: a planner receives a read-only
 * snapshot for decision-making. Runtime isolation does not rely on these
 * modifiers alone — the snapshot is a copied array of copied messages
 * (never the mutable `Conversation` object) and `agents` carries fresh
 * descriptor copies per planning call — so even a planner bypassing the
 * types via cast cannot mutate canonical conversation state or actual
 * agent configuration. Do NOT add speculative fields (tools, metadata,
 * agent/execution state, timestamps, token counts, model info).
 */
export interface PlannerInput {
  readonly input: string;
  readonly messages: readonly Message[];
  readonly agents: readonly AgentDescriptor[];
}
