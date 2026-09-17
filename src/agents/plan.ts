/**
 * An agent identity as carried in a `Plan`. Deliberately a plain string:
 * planners may name any agent from the descriptors they were offered, and
 * `MultiAgent` — not the type system — is the authority that determines
 * whether that name resolves to an executable child. There is exactly one
 * name type; descriptor names and plan names are the same strings.
 */
export type AgentName = string;

/**
 * The smallest useful plan: which agents should execute this request, in
 * order.
 *
 * A Plan answers only that question. The order of `agents` is meaningful:
 * `["research", "general"]` means run research, then general — never
 * concurrently, never deduplicated, never reordered. A single-agent plan
 * is the one-element case. Do NOT add speculative fields (steps,
 * reasoning, confidence, tools, dependencies, priorities, retries,
 * explanations, metadata) until an actual requirement exists.
 */
export interface Plan {
  agents: AgentName[];
}
