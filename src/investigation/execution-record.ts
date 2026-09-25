/**
 * The causal chain behind one execution: which investigation action
 * was executed, which execution ran, and which evidence it extracted,
 * if any.
 *
 * Answers "what did this execution do?" — "execution R ran for action
 * A" — plus, when the execution produced evidence, "why does E
 * exist?" ("E came from execution R"). It says NOTHING about what
 * anything means: correlation is provenance, not judgment. Only an
 * explicit `EvidenceEvaluation` can speak to support or contradiction.
 *
 * All identities reused — no new identity scheme:
 *
 * - `actionId`: the Phase 7 action's stable id.
 * - `resultId`: the existing `AgentResult.id`, already a stable
 *   per-execution UUID.
 * - `evidenceId`: evidence extracted/produced by this execution, if
 *   any — `null` when the execution extracted nothing. In particular
 *   an evaluation execution interprets existing evidence rather than
 *   producing new evidence, so its record carries `null` here. The
 *   evaluated evidence is represented by `EvidenceEvaluation.evidenceId`,
 *   never duplicated here: this field must not be reinterpreted as
 *   "evidence concerned by the execution."
 * - `hypothesisId`: the action's target, COPIED (not referenced)
 *   because actions are ephemeral decisions — deliberately no action
 *   history is stored — while records persist. `null` when the action
 *   targeted no hypothesis. This copy is the strictly-required minimum
 *   for the record to answer "which hypothesis was targeted" without
 *   an action store; it is not a verdict and must never be read as one.
 *
 * Pure data: ids only, never member objects. Frozen at creation (see
 * `createExecutionRecord` in `src/agents/execution-record.ts`, which
 * seals records from the linked members). This file imports nothing —
 * not even sibling domain types — so the shape stays free of every
 * dependency by construction.
 *
 * Do NOT extend this record with verdicts, standings, loops, retries,
 * or automatic follow-ups — those belong to later phases.
 */
export interface ExecutionRecord {
  readonly id: string;
  readonly actionId: string;
  readonly hypothesisId: string | null;
  readonly resultId: string;
  readonly evidenceId: string | null;
}
