import { randomUUID } from "node:crypto";
import type { InvestigationSource } from "./source.js";
import { assertValidSource } from "./source.js";

/**
 * Information that can support or contradict a hypothesis — as opposed
 * to an `Observation`, which records something seen without claiming
 * what it means.
 *
 * Two deliberate boundaries:
 *
 * - Provenance is mandatory: every piece of evidence says where it came
 *   from (`agent-assertion`, `tool-result`, `test-result`,
 *   `runtime-event`, `user-provided`). An LLM's statement recorded as
 *   `agent-assertion` evidence is still just an assertion — the source
 *   kind never confers verification.
 * - `hypothesisIds` names the hypotheses this evidence bears on
 *   (empty when not yet related). This is linkage only, not a verdict:
 *   there is no support/refute weight here. Falsification — deciding
 *   what the evidence means for a hypothesis — belongs to a later phase
 *   and must NOT be inferred from this list.
 *
 * Do NOT add speculative fields (weights, confidence, verdicts,
 * timestamps) until a concrete requirement exists.
 */
export interface Evidence {
  readonly id: string;
  readonly content: string;
  readonly source: InvestigationSource;
  readonly hypothesisIds: readonly string[];
}

/**
 * Seal freshly gathered evidence, optionally already related to
 * hypotheses. `id` defaults to a fresh UUID; pass an explicit id in
 * tests and when rehydrating known evidence.
 */
export function createEvidence(
  content: string,
  source: InvestigationSource,
  options: { id?: string; hypothesisIds?: readonly string[] } = {},
): Evidence {
  const id = options.id ?? randomUUID();
  if (id.trim() === "") {
    throw new Error("Evidence id must be a non-empty string");
  }
  if (content.trim() === "") {
    throw new Error("Evidence content must be a non-empty string");
  }
  assertValidSource(source);
  const hypothesisIds = [...(options.hypothesisIds ?? [])];
  for (const hypothesisId of hypothesisIds) {
    if (hypothesisId.trim() === "") {
      throw new Error("Evidence hypothesisIds must not contain empty ids");
    }
  }
  return Object.freeze({
    id,
    content,
    source: Object.freeze({ ...source }),
    hypothesisIds: Object.freeze(hypothesisIds),
  });
}

/**
 * Relate existing evidence to a hypothesis ("this bears on that") without
 * deciding what it means. Returns a new frozen object; the input is
 * untouched. Linking the same hypothesis twice is a no-op, never a
 * duplicate entry.
 */
export function linkEvidenceToHypothesis(evidence: Evidence, hypothesisId: string): Evidence {
  if (hypothesisId.trim() === "") {
    throw new Error("hypothesisId must be a non-empty string");
  }
  if (evidence.hypothesisIds.includes(hypothesisId)) {
    return evidence;
  }
  return Object.freeze({
    ...evidence,
    source: evidence.source,
    hypothesisIds: Object.freeze([...evidence.hypothesisIds, hypothesisId]),
  });
}
