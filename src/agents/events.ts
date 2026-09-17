import type { RuntimeEvent } from "../chat/events.js";

/**
 * Orchestration lifecycle events: which concrete agent is executing.
 *
 * Kept separate from `RuntimeEvent` (model/message output) on purpose.
 * `RuntimeEvent` answers "what was said"; these answer "who is running".
 * Do NOT add tool/planner/routing/reasoning/usage/tracing events here
 * until a concrete UI or observability requirement exists.
 */
export type AgentExecutionEvent =
  | {
      type: "agent_start";
      agent: string;
    }
  | {
      type: "agent_end";
      agent: string;
    };

/**
 * Everything an `Agent.run()` stream may yield: lifecycle brackets around
 * message output. Consumers switch on `type`; the two families never
 * overlap.
 */
export type AgentEvent = AgentExecutionEvent | RuntimeEvent;
