import { randomUUID } from "node:crypto";
import type { Agent, AgentRun } from "./agent.js";
import type { AgentContext } from "./context.js";
import { forkContext } from "./context.js";
import type { DelegationRequest } from "./delegation.js";
import type { Message } from "../chat/message.js";
import type { AgentEvent } from "./events.js";
import type { AgentResult } from "./result.js";
import { freezeResult } from "./result.js";
import type { Planner } from "./planner.js";

/** Shared empty run: no events, empty result. */
async function* noEvents(): AsyncGenerator<AgentEvent> {}

/**
 * Orchestration over an ordered plan: proves multiple agents can
 * participate behind the existing `Agent` interface. Asks the injected
 * `Planner` for a `Plan` (`agents` list), validates the whole list, then
 * runs each child sequentially — never concurrently — forwarding events
 * unchanged. MultiAgent itself contains NO routing rules — the policy
 * lives entirely in the planner.
 *
 * Execution identity: MultiAgent is orchestration, not a model-executing
 * agent, so it emits NO lifecycle events of its own — the stream contains
 * only each executed concrete child's `agent_start` … `agent_end`
 * bracket, in plan order. Its descriptor (`{ name: "multi", ... }`)
 * exists solely to satisfy the `Agent` identity invariant and never
 * appears in the event stream.
 *
 * Execution model: like `SingleAgent`, `run()` starts exactly one
 * underlying execution eagerly (plan → validate → fork → children →
 * publish, plus at most one inline delegated execution per requesting
 * child) shared by both `AgentRun` outputs, so `result` never requires
 * event drainage and each child runs exactly once.
 *
 * Planning gates the turn: the planner runs before any state change, so
 * a rejected plan executes NO agent and leaves the root conversation
 * untouched. The failure surfaces as the existing `error` event (no new
 * event type invented for planner failures) with an empty result. An
 * empty plan list is rejected the same way — it never silently becomes a
 * default agent.
 *
 * Full-plan validation (critical): every planned name must resolve to an
 * executable child BEFORE the first child starts — never execute one
 * child and then discover the next name is invalid. Unknown names follow
 * the planner-failure path (no execution, user message retained like any
 * failed turn): never
 * `planner → Agent object → execute()`.
 *
 * Context ownership (deliberate): the planner receives a `PlannerInput`
 * snapshot — copied messages plus FRESH descriptor copies built from this
 * very child collection, so the agents the planner can name are exactly
 * the agents that can execute — while each executed child receives its
 * own FORKED context (`forkContext`) — its own `Conversation` preloaded
 * with the root's messages, never the root's mutable instance — plus a
 * fresh snapshot of the results completed earlier in the plan
 * (`previousResults`). Only settled results flow forward, one way, in
 * execution order; a child can neither reach another agent nor mutate
 * another result.
 *
 * The root conversation stays the canonical user-visible history and is
 * maintained HERE, not in the children: the user message is recorded up
 * front (so it survives failures, exactly as before), and each completed
 * child's published `AgentResult` is appended in execution order as it
 * completes. A mid-sequence child failure keeps what completed children
 * published (no rollback, no fabrication) and ends the plan there.
 * Results are taken from the result contract — never reconstructed from
 * `text_delta` events. There is deliberately NO merge of child
 * conversation objects back into the parent — isolation, not
 * synchronization. Fork timing also matters: forks are taken before the
 * current user message is recorded, so each child adds that message
 * itself and no model ever sees it twice.
 *
 * Input forwarding: the original input is passed unchanged (including a
 * `/research ` prefix) to both the planner and every child, so each
 * child and its model see exactly what the user typed.
 *
 * Events: forwarded verbatim as each child yields them. Child `error`
 * (and each child's closing `agent_end`) are forwarded unchanged: no
 * catching, no transformation, no retry, no fallback to another agent.
 *
 * Empty/whitespace input is a no-op: no planning, no fork, no child
 * invoked, no events, empty result, root conversation untouched (matches
 * `SingleAgent` behavior).
 */
export class MultiAgent implements Agent {
  readonly descriptor = {
    name: "multi",
    description: "Routes each request to exactly one child agent.",
  };

  constructor(
    private readonly children: Record<string, Agent>,
    private readonly planner: Planner,
  ) {}

  run(input: string, context: AgentContext): AgentRun {
    const content = input.trim();
    // Fresh execution identity for this run's own combined result.
    // Child results keep the IDs their producers minted (pass-through).
    const resultId = randomUUID();
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
      // Published only on the full-success path below; planning failures
      // keep the default empty result, and a mid-sequence child failure
      // keeps what completed children published (no rollback, see below).
      let outcome: AgentResult = freezeResult(resultId, self.descriptor.name, []);
      const published: Message[] = [];
      let plan;
      try {
        // Snapshot-first ordering: the planner sees previous history plus
        // the current input separately — the current user message is only
        // recorded in the root AFTER planning succeeds, so it can never
        // appear duplicated inside the snapshot. Descriptors are fresh
        // per-run copies, so planner mutation cannot touch agent config.
        plan = await self.planner.plan({
          input,
          messages: context.conversation.getMessages(),
          agents: Object.values(self.children).map((child) => ({
            ...child.descriptor,
          })),
        });
      } catch (err) {
        // Planning failed: no agent executes, root untouched. Reuses the
        // existing error event rather than inventing a planner-error type.
        emit({
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
        finished = true;
        wake();
        settleResult(outcome);
        return;
      }

      if (plan.agents.length === 0) {
        // An empty plan is an invalid planner result, never a silent
        // default agent. Same failure path as a rejected plan.
        emit({
          type: "error",
          error: new Error("Invalid plan: no agents selected"),
        });
        finished = true;
        wake();
        settleResult(outcome);
        return;
      }

      // One independent fork per planned child, all snapshotted before the
      // current user message is recorded below, so each child adds that
      // message itself and no model ever sees it twice.
      const childContexts = plan.agents.map(() => forkContext(context));
      context.conversation.add("user", content);

      // Full-plan validation BEFORE the first child starts: a syntactically
      // valid plan must be fully executable, so a later unknown name can
      // never strand a partial execution. Rejected like a planner failure,
      // except the already-recorded user message is retained as in any
      // failed turn.
      const unknown = plan.agents.find(
        (name) => self.children[name] === undefined,
      );
      if (unknown !== undefined) {
        emit({
          type: "error",
          error: new Error(`Unknown agent: ${JSON.stringify(unknown)}`),
        });
        finished = true;
        wake();
        settleResult(outcome);
        return;
      }

      try {
        // Sequential execution only: each child runs to completion before
        // the next starts. No Promise.all, no concurrency.
        //
        // Every completed child's messages are appended to the root AND
        // collected in `published`, so the settled result always mirrors
        // exactly what the root gained — on full success and on
        // mid-sequence failure alike. Nothing is ever fabricated: only
        // completed child results are published. The list is frozen at
        // settle time in `finally` below.
        //
        // One-way result flow: each child receives a fresh snapshot of the
        // results completed before it started (`completedResults`), on top
        // of its own pre-made conversation fork. Children never see each
        // other's agents or contexts — only settled, immutable results.
        //
        // Delegation: when a child's `delegation_request` event is
        // observed, exactly one delegated execution runs inline (see
        // `executeDelegation` below) before the outer stream continues.
        // The delegated child's events flow through verbatim and its
        // settled result joins `completedResults`/root exactly like a
        // planned child's. Depth is capped structurally at one: delegated
        // runs forward events without interception, so a nested request
        // stays observable data and never triggers another execution.
        const completedResults: AgentResult[] = [];

        async function executeDelegation(request: DelegationRequest): Promise<void> {
          const target = self.children[request.agent];
          if (target === undefined) {
            emit({
              type: "error",
              error: new Error(`Unknown agent: ${JSON.stringify(request.agent)}`),
            });
            return;
          }
          // Isolated fork of the CURRENT root (never the requester's
          // mutable conversation) plus the results completed so far —
          // never the requester's unfinished output.
          const delegatedContext: AgentContext = {
            ...forkContext(context),
            previousResults: [...completedResults],
          };
          const delegatedRun = target.run(request.input, delegatedContext);
          for await (const event of delegatedRun.events) {
            emit(event);
          }
          const delegatedResult = await delegatedRun.result;
          completedResults.push(delegatedResult);
          for (const message of delegatedResult.messages) {
            context.conversation.add(message.role, message.content);
            published.push({ role: message.role, content: message.content });
          }
        }

        for (let index = 0; index < plan.agents.length; index++) {
          const child = self.children[plan.agents[index] as string];
          const childRun = child.run(input, {
            ...childContexts[index] as AgentContext,
            previousResults: [...completedResults],
          });
          // At most one delegation per requesting execution: the first
          // request runs inline, extras are rejected as errors (not
          // silently multiplied into a task scheduler).
          let delegated = false;
          for await (const event of childRun.events) {
            emit(event);
            if (event.type !== "delegation_request") {
              continue;
            }
            if (delegated) {
              emit({
                type: "error",
                error: new Error(
                  "Only one delegation per execution is supported",
                ),
              });
              continue;
            }
            delegated = true;
            await executeDelegation(event.request);
          }
          const childResult = await childRun.result;
          completedResults.push(childResult);
          for (const message of childResult.messages) {
            context.conversation.add(message.role, message.content);
            published.push({ role: message.role, content: message.content });
          }
        }
        outcome = freezeResult(resultId, self.descriptor.name, published);
      } catch (unexpected) {
        // Mid-sequence failure: completed children stay published (their
        // messages are already canonical root history — no rollback), while
        // the failing child contributes nothing further. Its error event,
        // already forwarded above, marks the failure; freeze whatever was
        // published so the result mirrors root exactly.
        outcome = freezeResult(resultId, self.descriptor.name, published);
        failure = { error: unexpected };
      } finally {
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

    // Eager, exactly-once execution: plan → fork → single child run →
    // publish, independent of whether (or when) anyone iterates `events`
    // or awaits `result`. Never rejects by construction.
    void execute();

    return { events: events(), result };
  }
}
