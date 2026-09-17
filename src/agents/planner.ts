import type { PlannerInput } from "./planner-input.js";
import type { Plan } from "./plan.js";

/**
 * Decides which agent should execute a request; does NOT execute anything.
 *
 * Important distinction: `Planner` decides, `Agent` executes. The planner
 * emits no `AgentEvent`s, mutates nothing, and receives no mutable
 * application state — only a `PlannerInput` snapshot (current input plus
 * copied history). A future `LLMPlanner` can implement this same contract
 * without changing `MultiAgent`.
 *
 * It returns only a `Plan`.
 */
export interface Planner {
  plan(input: PlannerInput): Promise<Plan>;
}
