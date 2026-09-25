import type { InvestigationAction } from "../investigation/action.js";
import type { AgentResult } from "./result.js";
import type { Evidence } from "../investigation/evidence.js";
import type { EvaluationRelation, EvidenceEvaluation } from "../investigation/evaluation.js";
import { createEvaluation } from "../investigation/evaluation.js";

/**
 * Pure adapter from an agent's raw output to an evaluation PROPOSAL —
 * the first point where agent output may influence hypothesis standing,
 * and only through the domain's own machinery.
 *
 * The agent proposes; the domain disposes. This function parses the
 * result's message text into a typed `EvidenceEvaluation` proposal and
 * stops there: it never calls `applyEvaluation`, never touches
 * `transitionHypothesis` (no `if relation === ...: status = ...`
 * logic anywhere here), and changes no standing or status. The caller
 * applies the proposal through the existing domain function — or not.
 *
 * Why a parser, and why this strict: `LLMClient` yields raw strings
 * only (`AsyncIterable<string>` / `Promise<string>`) — the runtime has
 * no structured-output mechanism to reuse. So the boundary is a
 * minimal deterministic format, not a framework, and the domain never
 * learns to read prose:
 *
 * ```text
 * Evidence: <evidenceId>
 * Hypothesis: <hypothesisId>
 * Relation: supports | contradicts | inconclusive
 * Reasoning: <why, on one line>
 * ```
 *
 * Blank lines are ignored; anything else is malformed and throws. The
 * parsed ids are then cross-checked against the members the caller
 * already holds — the proposal cannot invent evidence, cannot name an
 * unknown hypothesis, and cannot silently retarget:
 *
 * - parsed `evidenceId` must equal `evidence.id` (unknown/forged
 *   evidence ids rejected);
 * - parsed `hypothesisId` must equal the originating action's
 *   `hypothesisId` (retargeting rejected);
 * - `relation` must be exactly one of the existing
 *   `EvaluationRelation` values (no confidence, no probability, no
 *   truth scores — the three words are sufficient, and `inconclusive`
 *   is a valid outcome);
 * - `reasoning` must be non-empty (the domain requires an explanation;
 *   an empty one is malformed, never coerced).
 *
 * Only `evaluate-hypothesis` actions can yield proposals (`finish` and
 * `undetermined` request no execution, so there is nothing to
 * interpret), and an empty result (no message text) throws instead of
 * inventing a proposal from nothing.
 *
 * Sealing goes through the existing domain `createEvaluation`, which
 * re-validates and freezes — validation lives in the domain, parsing
 * lives here. Members are read, never mutated; `Evidence` stays
 * verdict-free (`hypothesisIds` untouched — linkage is not a verdict).
 *
 * Lives on the runtime side (`src/agents/`, next to the other two
 * adapters) so `src/investigation/` keeps importing nothing from the
 * runtime.
 *
 * Do NOT extend this adapter with application, loops, retries, or
 * status derivation — those belong to later phases.
 */
export function agentResultToEvaluation(
  action: InvestigationAction,
  result: AgentResult,
  evidence: Evidence,
  options: { id?: string } = {},
): EvidenceEvaluation {
  if (action.kind !== "evaluate-hypothesis") {
    throw new Error(
      `Cannot propose evaluation for ${JSON.stringify(action.kind)} action: it requests no execution`,
    );
  }
  const output = result.messages.map((message) => message.content).join("\n");
  if (output.trim() === "") {
    throw new Error("Cannot propose evaluation from an empty agent result");
  }
  const fields = parseProposal(output);
  if (fields.evidenceId !== evidence.id) {
    throw new Error(
      `Proposed evidence id ${JSON.stringify(fields.evidenceId)} does not match evidence ${JSON.stringify(evidence.id)}`,
    );
  }
  if (fields.hypothesisId !== action.hypothesisId) {
    throw new Error(
      `Proposed hypothesis id ${JSON.stringify(fields.hypothesisId)} does not match action target ${JSON.stringify(action.hypothesisId)}`,
    );
  }
  return createEvaluation(
    evidence.id,
    action.hypothesisId,
    fields.relation,
    fields.reasoning,
    options.id,
  );
}

interface ProposalFields {
  evidenceId: string;
  hypothesisId: string;
  relation: EvaluationRelation;
  reasoning: string;
}

/**
 * Parse the strict four-field proposal format. Keys are
 * case-sensitive; values are single-line and trimmed. Throws on
 * anything malformed — missing or duplicated fields, unknown lines,
 * or a relation outside the existing vocabulary. Never coerces.
 */
function parseProposal(output: string): ProposalFields {
  const seen = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new Error(`Malformed evaluation proposal line: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== "Evidence" && key !== "Hypothesis" && key !== "Relation" && key !== "Reasoning") {
      throw new Error(`Malformed evaluation proposal line: ${JSON.stringify(line)}`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate field in evaluation proposal: ${JSON.stringify(key)}`);
    }
    seen.set(key, value);
  }
  for (const key of ["Evidence", "Hypothesis", "Relation", "Reasoning"] as const) {
    if (!seen.has(key)) {
      throw new Error(`Evaluation proposal is missing field: ${JSON.stringify(key)}`);
    }
  }
  const relation = seen.get("Relation") as string;
  if (relation !== "supports" && relation !== "contradicts" && relation !== "inconclusive") {
    throw new Error(`Invalid evaluation relation: ${JSON.stringify(relation)}`);
  }
  return {
    evidenceId: seen.get("Evidence") as string,
    hypothesisId: seen.get("Hypothesis") as string,
    relation,
    reasoning: seen.get("Reasoning") as string,
  };
}
