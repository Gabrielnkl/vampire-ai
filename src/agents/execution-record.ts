import { randomUUID } from "node:crypto";
import type { InvestigationAction } from "../investigation/action.js";
import type { ExecutionRecord } from "../investigation/execution-record.js";
import type { AgentResult } from "./result.js";
import type { Evidence } from "../investigation/evidence.js";

/**
 * Seal a fresh execution record from the members it links — the
 * runtime-side factory for the pure `ExecutionRecord` shape in
 * `src/investigation/execution-record.ts`.
 *
 * Lives here (`src/agents/`, next to the two adapters it correlates)
 * — NOT in `src/investigation/` — because sealing needs the member
 * objects (`InvestigationAction`, `AgentResult`, and, when the
 * execution extracted evidence, `Evidence`), and the investigation
 * domain must keep importing nothing from the runtime. Members are
 * read, never mutated and never stored: only their ids enter the
 * record.
 *
 * Pass `null` for `evidence` when the execution extracted nothing —
 * notably evaluation executions, which interpret existing evidence
 * rather than producing new evidence. The evaluated evidence is
 * represented by `EvidenceEvaluation.evidenceId`, never duplicated
 * here.
 *
 * Only `evaluate-hypothesis` actions can be recorded: `finish` and
 * `undetermined` request no execution by definition (see
 * `investigationActionToRequest`), so a record for either would assert
 * an execution that must not exist. Enforced structurally, not by
 * convention. Future executable action kinds extend this function;
 * nothing here anticipates them.
 *
 * The record trusts its caller on one point by necessity: nothing in
 * `AgentResult` or `Evidence` links the two (independent identity
 * domains, a deliberate Phase 2 decision), so this record IS the link
 * when evidence is passed. It validates what it can — kinds,
 * identities, non-emptiness.
 *
 * Sealing a record executes nothing, evaluates nothing, and changes no
 * standing or status anywhere.
 *
 * `id` defaults to a fresh UUID; pass an explicit id in tests and when
 * rehydrating a known record.
 *
 * Do NOT extend this factory with verdicts, standings, loops, retries,
 * or automatic follow-ups — those belong to later phases.
 */
export function createExecutionRecord(
  action: InvestigationAction,
  result: AgentResult,
  evidence: Evidence | null,
  id: string = randomUUID(),
): ExecutionRecord {
  if (id.trim() === "") {
    throw new Error("ExecutionRecord id must be a non-empty string");
  }
  if (action.kind !== "evaluate-hypothesis") {
    throw new Error(
      `Cannot record execution for ${JSON.stringify(action.kind)} action: it requests no execution`,
    );
  }
  if (result.id.trim() === "") {
    throw new Error("ExecutionRecord requires a result with a non-empty id");
  }
  return Object.freeze({
    id,
    actionId: action.id,
    hypothesisId: action.hypothesisId,
    resultId: result.id,
    evidenceId: evidence?.id ?? null,
  });
}
