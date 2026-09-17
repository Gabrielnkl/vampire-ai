import type { AgentDescriptor } from "./descriptor.js";
import type { AgentEvent } from "./events.js";
import type { AgentResult } from "./result.js";
import type { AgentContext } from "./context.js";

/**
 * One agent execution, split into two channels:
 *
 * - `events`: asynchronously streamable `AgentEvent`s driving streaming
 *   UI and observability ("what happened while running").
 * - `result`: separately awaitable `AgentResult` driving state
 *   propagation to the parent ("what was produced"). Callers must NOT
 *   reconstruct the result from `text_delta` events.
 *
 * The result promise settles when the underlying execution completes,
 * independent of whether (or when) anyone drains the event stream.
 * Domain failures (e.g. LLM errors) resolve to `{ messages: [] }` —
 * result promises carry results, never domain errors.
 */
export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentResult>;
}

/**
 * Minimal application-level agent abstraction.
 *
 * Describes what an agent does (turn input + execution context into an
 * `AgentRun`), not how it does it. Deliberately free of agent IDs,
 * metadata, routing, tools, child agents, registries, and lifecycle
 * hooks — those belong to later iterations beyond the current
 * `SingleAgent` / `MultiAgent` pair.
 *
 * Identity is a stable human-readable descriptor (`name`, e.g.
 * "general"), not a UUID or registry ID. Every concrete agent execution
 * brackets itself with `agent_start` / `agent_end` carrying that name.
 * The descriptor is the single source of truth — there is no separate
 * `name` field duplicating it.
 *
 * The agent receives execution context; callers that only present output
 * (like the TUI) should be given a context-bound events invocation
 * instead of the raw context. See the composition root in `src/index.tsx`.
 */
export interface Agent {
  readonly descriptor: AgentDescriptor;

  run(input: string, context: AgentContext): AgentRun;
}
