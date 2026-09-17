import type { PlannerInput } from "./planner-input.js";
import type { Plan } from "./plan.js";
import type { Planner } from "./planner.js";

/**
 * Pure prefix-based planning, moved here from the former `route()`
 * function so the policy lives in one testable place outside `MultiAgent`.
 *
 * - `/research ...` → `"research"` (case-insensitive, leading whitespace
 *   accepted; the model-facing prefix is significant, so bare `/research`
 *   without a trailing space stays `"general"`)
 * - everything else → `"general"`
 *
 * Routes on `input.input` only: conversation history has no effect, so
 * existing behavior is preserved exactly — the single-agent policy is
 * expressed as a one-element plan. The preferred agent is returned
 * only if it actually exists in `input.agents` (falling back to general,
 * then rejecting when nothing is executable) so the planner can never
 * name an agent `MultiAgent` cannot execute. Receives a snapshot and
 * touches nothing. Returns only a `Plan`.
 */
export class DeterministicPlanner implements Planner {
  plan(input: PlannerInput): Promise<Plan> {
    const names = input.agents.map((agent) => agent.name);
    if (
      input.input.trimStart().toLowerCase().startsWith("/research ") &&
      names.includes("research")
    ) {
      return Promise.resolve({ agents: ["research"] });
    }
    if (names.includes("general")) {
      return Promise.resolve({ agents: ["general"] });
    }
    return Promise.reject(
      new Error("DeterministicPlanner: no executable agent available"),
    );
  }
}
