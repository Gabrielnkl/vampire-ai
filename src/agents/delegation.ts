/**
 * A request from one agent for another agent to perform some work:
 * WHO should execute (`agent`) and WHAT they should execute (`input`).
 *
 * This is a request boundary, not an execution mechanism — producing a
 * `DelegationRequest` never executes anything by itself. It is
 * deliberately separate from `AgentResult`: a result means "this is what
 * the agent produced", while a request means "this is work the agent
 * wants another agent to perform". The runtime owns execution context,
 * so requests carry no IDs, priorities, contexts, results, callbacks, or
 * options.
 *
 * Structurally readonly with runtime freezing (see
 * `freezeDelegationRequest`); a malicious consumer cannot repoint a
 * request at a different agent or rewrite its input.
 */
export interface DelegationRequest {
  readonly agent: string;
  readonly input: string;
}

/**
 * Seal a freshly built request before emitting it. Local to this
 * boundary — not a generic utility.
 */
export function freezeDelegationRequest(
  agent: string,
  input: string,
): DelegationRequest {
  return Object.freeze({ agent, input });
}
