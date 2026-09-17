/**
 * Read-only metadata about an available agent: what it is called and what
 * it does. A descriptor is data for planners, not an execution
 * abstraction — planners receive descriptors, never `Agent` objects, so
 * they can read capabilities without being able to execute anything.
 * Fields are explicitly readonly; `MultiAgent` additionally hands out
 * fresh copies per planning call, so planner-side mutation (including via
 * cast) cannot reach actual agent configuration.
 *
 * Do NOT add speculative fields (tools, capabilities arrays, models,
 * prompts, configuration, priorities, costs, metadata, schemas,
 * permissions) until an actual requirement exists.
 */
export interface AgentDescriptor {
  readonly name: string;
  readonly description: string;
}
