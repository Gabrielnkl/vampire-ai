import { randomUUID } from "node:crypto";
import type { LLMClient } from "../llm/client.js";
import type { Message } from "../chat/message.js";
import type { AgentDescriptor } from "./descriptor.js";
import type { AgentEvent } from "./events.js";
import type { Agent, AgentRun } from "./agent.js";
import type { AgentResult } from "./result.js";
import { freezeResult } from "./result.js";
import type { AgentContext } from "./context.js";
import type { DelegationRequest } from "./delegation.js";
import { freezeDelegationRequest } from "./delegation.js";
import type { Skill } from "../skills/skill.js";
import { freezeSkill } from "../skills/skill.js";
import { skillInstructionsMessages } from "../skills/prompt.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import { defaultToolsOptions } from "../tools/tool.js";
import type { ToolAuditEntry } from "../tools/audit.js";
import { appendToolAudit } from "../tools/audit.js";
import { preview, truncate } from "../tools/policy.js";
import type { ToolSpec } from "../llm/client.js";

/** Shared empty run: no events, empty result. */
async function* noEvents(): AsyncGenerator<AgentEvent> {}

/**
 * Render settled prior-agent results as one explicit runtime-context
 * message for the LLM request. Each included result is labeled with its
 * authoritative producer name. Returns null when there is nothing to
 * show, so result-free runs send exactly the request they always sent.
 * Numbering counts included results only. Read-only: builds a fresh
 * message without touching the conversation or the supplied results.
 */
function previousResultsMessage(
  previousResults: readonly AgentResult[],
): Message | null {
  const blocks: string[] = [];
  for (const result of previousResults) {
    if (result.messages.length === 0) {
      continue;
    }
    blocks.push(
      `[Result ${blocks.length + 1} — ${result.agent}]\n` +
        result.messages.map((message) => message.content).join("\n"),
    );
  }
  if (blocks.length === 0) {
    return null;
  }
  return {
    role: "system",
    content:
      "Previous agent results (runtime execution context, not conversation history):\n" +
      blocks.join("\n\n"),
  };
}

/**
 * First `Agent` implementation: the former `ChatRuntime` chat behavior.
 * Holds no conversation state itself — the canonical `Conversation` comes
 * from the `AgentContext` on each run (application state), keeping this
 * agent reusable across independent contexts.
 *
 * Execution model: `run()` starts exactly one underlying execution
 * eagerly and returns immediately. That execution pushes `AgentEvent`s
 * into a small local buffer as they occur and settles the `result`
 * promise on completion — so `events` and `result` are two views of the
 * same execution, and neither requires the other to be consumed. A late
 * (or non-) consumer of `events` replays (or skips) the buffer; awaiting
 * `result` alone never hangs.
 *
 * Lifecycle: every non-empty run is bracketed with
 * `agent_start(name)` … `agent_end(name)`, with the existing message
 * events in between:
 *
 * Success: agent_start → message_start → text_delta* → message_end → agent_end.
 * Empty response: agent_start → message_start → message_end → agent_end
 *   (no assistant message stored).
 * Failure: agent_start → message_start → text_delta* → error → agent_end
 *   (no message_end, partial response not stored, user message retained).
 *
 * `agent_end` means "execution of this agent has ended" — NOT "it
 * succeeded". Success of the message is signaled by `message_end`; its
 * absence alongside an `error` event signals failure. There is deliberately
 * no separate `agent_failed` event.
 *
 * Result: `{ messages: [assistant(fullText)] }` on successful non-empty
 * output, `{ messages: [] }` on empty responses and on failure. Partial
 * streamed output is an execution detail, never a published result. The
 * result promise carries results, never domain errors.
 *
 * Delegation requests: an execution may additionally emit
 * `delegation_request` events for explicitly configured static requests
 * (see the constructor). Requests are request information only — emitting
 * one executes nothing, publishes nothing, and mutates no history. They
 * appear in `events` right after `agent_start`, before any message
 * events. Ordinary LLM text never becomes a request: there is no prose
 * parsing, only this explicit list. Note the execution runs to completion
 * from run-start state — a delegated result produced elsewhere can never
 * flow back into this execution's own LLM call. Resuming an execution
 * with new context would require a suspendable AgentRun, which is
 * deliberately out of scope (see the delegation continuation limit).
 *
 * Execution context: `context.previousResults` (settled results of
 * earlier agents in the same plan) are rendered as one trailing system
 * message on the LLM request — runtime-supplied context, never
 * conversation history. The conversation itself is never modified for
 * this, and an empty result list sends the request unchanged.
 *
 * Skills: agent-bound `Skill` prompt packages (see `src/skills/`) passed
 * at construction are rendered as trailing `system` messages after any
 * previous-results message — request-only context, never conversation
 * history. Defaults to none, preserving existing behavior.
 *
 * Tools: agent-bound `Tool`s (see `src/tools/`) executed via an agentic
 * loop. When tools are bound AND the LLM client supports `streamStep`
 * (OpenAI function calling), each run loops: model step → execute
 * requested tools sequentially → feed results back → repeat until the
 * model stops calling tools or `maxSteps` is hit. Tool transcripts live
 * only in the ephemeral working list and the audit log — never in the
 * canonical `Conversation` or `AgentResult`. Tool failures become result
 * strings the model can recover from, not `error` events. Without tools
 * (or with a client lacking `streamStep`), behavior is exactly the legacy
 * single-shot `stream()`.
 *
 * Error strategy (preserved): LLM failures are reported as an `error` event
 * and execution then ends WITHOUT rethrowing. The same failure is never
 * both yielded and thrown. A truly unexpected exception still propagates
 * to whoever is draining `events` (after `agent_end`), while the result
 * stays empty.
 */
export interface SingleAgentToolsOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxSteps?: number;
  /** Empty string disables the audit log. */
  readonly logPath?: string;
}

type WorkingMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export class SingleAgent implements Agent {
  private readonly delegations: readonly DelegationRequest[];
  private readonly skills: readonly Skill[];
  private readonly tools: readonly Tool[];
  private readonly toolsOptions: Required<SingleAgentToolsOptions>;

  constructor(
    private readonly llm: LLMClient,
    readonly descriptor: AgentDescriptor,
    delegations: readonly DelegationRequest[] = [],
    skills: readonly Skill[] = [],
    tools: readonly Tool[] = [],
    toolsOptions: SingleAgentToolsOptions = {},
  ) {
    // Sealed once at construction: every run emits these same immutable
    // request objects. Defaults to none, preserving existing behavior.
    this.delegations = delegations.map((request) =>
      freezeDelegationRequest(request.agent, request.input),
    );
    // Agent-bound skills: sealed copies so later caller-side mutation
    // cannot change agent behavior.
    this.skills = skills.map((skill) => freezeSkill(skill));
    // Tools are stateless singletons shared by reference (no per-agent
    // state to seal); the array itself is copied so later appends by the
    // caller cannot change agent behavior.
    this.tools = [...tools];
    const defaults = defaultToolsOptions();
    const timeoutMs =
      toolsOptions.timeoutMs ?? defaults.timeoutMs;
    this.toolsOptions = {
      cwd: toolsOptions.cwd ?? defaults.cwd,
      // Guard NaN/Infinity/negatives from env parsing: fall back to default.
      timeoutMs:
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaults.timeoutMs,
      maxSteps: toolsOptions.maxSteps ?? defaults.maxSteps,
      logPath: toolsOptions.logPath ?? defaults.logPath,
    };
  }

  /**
   * Bounded agentic loop. `base` is the request built by `execute()`
   * (conversation snapshot + previous-results + skills). Tool transcripts
   * accumulate in a local `working` list only; the canonical conversation
   * is untouched. Returns the accumulated assistant text.
   *
   * Throws on transport failure, step/call-cap exhaustion, or a missing
   * `streamStep` — the caller maps throws to the existing `error` path
   * (no `message_end`, empty result, user message retained).
   */
  private async runToolLoop(
    base: Message[],
    emit: (event: AgentEvent) => void,
  ): Promise<string> {
    const specs: ToolSpec[] = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const byName = new Map(this.tools.map((t) => [t.name, t]));
    const toolCtx: ToolContext = {
      cwd: this.toolsOptions.cwd,
      timeoutMs: this.toolsOptions.timeoutMs,
    };
    const working: WorkingMessage[] = base.map((m) => ({ ...m }));
    let full = "";
    const rawSteps = this.toolsOptions.maxSteps;
    const maxSteps =
      Number.isFinite(rawSteps) && rawSteps > 0
        ? Math.floor(rawSteps)
        : 8;
    const MAX_CALLS_PER_STEP = 8;

    for (let step = 0; step < maxSteps; step++) {
      const result = await this.llm.streamStep?.(working as Message[], specs);
      if (result === undefined) {
        throw new Error("LLM client does not support streamStep.");
      }
      if (result.text) {
        full += result.text;
        emit({ type: "text_delta", text: result.text });
      }
      if (result.toolCalls.length === 0) {
        return full;
      }
      if (result.toolCalls.length > MAX_CALLS_PER_STEP) {
        throw new Error(
          `Too many tool calls in one step (${result.toolCalls.length} > ${MAX_CALLS_PER_STEP}).`,
        );
      }
      if (step === maxSteps - 1) {
        throw new Error(
          `Max tool steps (${maxSteps}) reached with ${result.toolCalls.length} pending tool call(s).`,
        );
      }
      const calls = result.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      }));
      working.push({
        role: "assistant",
        content: result.text,
        tool_calls: calls,
      });
      for (const call of result.toolCalls) {
        emit({ type: "tool_start", name: call.name, args: call.arguments });
        const { ok, output } = await this.executeOneTool(
          call.name,
          call.arguments,
          byName,
          toolCtx,
        );
        emit({ type: "tool_end", name: call.name, ok, preview: preview(output) });
        const entry: ToolAuditEntry = {
          ts: new Date().toISOString(),
          agent: this.descriptor.name,
          tool: call.name,
          args: call.arguments,
          ok,
          output: truncate(output),
        };
        await appendToolAudit(this.toolsOptions.logPath, entry);
        working.push({
          role: "tool",
          content: output,
          tool_call_id: call.id,
        });
      }
    }
    return full;
  }

  private async executeOneTool(
    name: string,
    argsJson: string,
    byName: Map<string, Tool>,
    ctx: ToolContext,
  ): Promise<{ ok: boolean; output: string }> {
    const tool = byName.get(name);
    if (tool === undefined) {
      return { ok: false, output: `Error: unknown tool ${JSON.stringify(name)}.` };
    }
    let args: unknown;
    try {
      args = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
    } catch {
      return {
        ok: false,
        output: `Error: invalid JSON arguments for ${JSON.stringify(name)}.`,
      };
    }
    try {
      return { ok: true, output: await tool.execute(args, ctx) };
    } catch (err) {
      return {
        ok: false,
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  run(input: string, context: AgentContext): AgentRun {
    // Fresh execution identity: minted here so every run() call — even an
    // empty or failed one — settles a distinctly identified result.
    const resultId = randomUUID();
    const content = input.trim();
    if (content === "") {
      return { events: noEvents(), result: Promise.resolve(freezeResult(resultId, this.descriptor.name, [])) };
    }

    const self = this;
    const buffered: AgentEvent[] = [];
    let finished = false;
    let failure: { error: unknown } | null = null;
    const waiters: Array<() => void> = [];
    const wake = (): void => {
      const pending = waiters.splice(0, waiters.length);
      for (const resume of pending) resume();
    };
    const emit = (event: AgentEvent): void => {
      buffered.push(event);
      wake();
    };

    let settleResult!: (result: AgentResult) => void;
    const result = new Promise<AgentResult>((resolve) => {
      settleResult = resolve;
    });

    async function execute(): Promise<void> {
      // Published only on the success path below; failures and empty
      // responses keep the default empty result.
      let outcome: AgentResult = freezeResult(resultId, self.descriptor.name, []);
      emit({ type: "agent_start", agent: self.descriptor.name });
      // Explicit delegation requests, if configured: request information
      // only, emitted before any message events. Never executed,
      // published, or recorded here.
      for (const request of self.delegations) {
        emit({ type: "delegation_request", request });
      }
      try {
        const conversation = context.conversation;
        conversation.add("user", content);
        emit({ type: "message_start", role: "assistant" });

        let full = "";
        try {
          const request = conversation.getMessages();
          const contextMessage = previousResultsMessage(
            context.previousResults,
          );
          const skillMessages = skillInstructionsMessages(self.skills);
          const base: Message[] = [
            ...request,
            ...(contextMessage ? [contextMessage] : []),
            ...skillMessages,
          ];
          if (self.tools.length === 0 || self.llm.streamStep === undefined) {
            for await (const delta of self.llm.stream(base)) {
              if (delta) {
                full += delta;
                emit({ type: "text_delta", text: delta });
              }
            }
          } else {
            full = await self.runToolLoop(base, emit);
          }
        } catch (err) {
          emit({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          });
          return;
        }

        // Only stored after the stream completes successfully.
        if (full !== "") {
          conversation.add("assistant", full);
          outcome = freezeResult(resultId, self.descriptor.name, [{ role: "assistant", content: full }]);
        }
        emit({ type: "message_end" });
      } catch (unexpected) {
        // Unexpected failure (not an LLM stream error): recorded for
        // whoever drains `events`; the published result stays empty.
        failure = { error: unexpected };
      } finally {
        // Always closes the bracket opened by agent_start — on success and
        // on failure alike. Means "execution ended", not "execution succeeded".
        emit({ type: "agent_end", agent: self.descriptor.name });
        finished = true;
        wake();
        settleResult(outcome);
      }
    }

    async function* events(): AsyncGenerator<AgentEvent> {
      let index = 0;
      for (;;) {
        while (index < buffered.length) {
          yield buffered[index++] as AgentEvent;
        }
        if (finished) {
          if (failure !== null) throw failure.error;
          return;
        }
        await new Promise<void>((resolve) => {
          waiters.push(() => resolve());
        });
      }
    }

    // Eager, exactly-once execution: starts now, independent of whether
    // (or when) anyone iterates `events` or awaits `result`. Never rejects
    // by construction — domain failures become `error` events and
    // unexpected ones are captured for the event consumer above.
    void execute();

    return { events: events(), result };
  }
}
