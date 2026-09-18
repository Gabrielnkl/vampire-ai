import type { RuntimeEvent } from "../chat/events.js";
import type { DelegationRequest } from "./delegation.js";

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
 * Everything an `Agent.run()` stream may yield: lifecycle brackets and
 * delegation requests around message output. Consumers switch on `type`;
 * the three families never overlap.
 *
 * - `AgentExecutionEvent`: who is running (observability).
 * - `RuntimeEvent`: what was said (message output).
 * - `delegation_request`: work an agent wants another agent to perform
 *   (request information only — emitting it executes nothing; no current
 *   producer or consumer acts on it beyond forwarding and display).
 */
export type AgentEvent =
  | AgentExecutionEvent
  | RuntimeEvent
  | {
      type: "delegation_request";
      request: DelegationRequest;
    };
