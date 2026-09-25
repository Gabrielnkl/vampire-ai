import { randomUUID } from "node:crypto";
import type { InvestigationSource } from "./source.js";
import { assertValidSource } from "./source.js";

/**
 * Something observed during an investigation — as opposed to `Evidence`,
 * which is information deliberately taken to bear on a hypothesis.
 *
 * An observation is NOT a conclusion and NOT evidence: recording what
 * was seen (including an LLM's statement) claims nothing about whether
 * it is true or what it supports. Content plus provenance are frozen at
 * creation; interpretation happens elsewhere.
 *
 * Do NOT add speculative fields (timestamps, confidence, verdicts,
 * hypothesis links) until a concrete requirement exists. In particular,
 * observations carry no hypothesis references — relating information to
 * hypotheses is `Evidence`'s job.
 */
export interface Observation {
  readonly id: string;
  readonly content: string;
  readonly source: InvestigationSource;
}

/**
 * Seal a freshly made observation. `id` defaults to a fresh UUID; pass
 * an explicit id in tests and when rehydrating a known observation.
 */
export function createObservation(
  content: string,
  source: InvestigationSource,
  id: string = randomUUID(),
): Observation {
  if (id.trim() === "") {
    throw new Error("Observation id must be a non-empty string");
  }
  if (content.trim() === "") {
    throw new Error("Observation content must be a non-empty string");
  }
  assertValidSource(source);
  return Object.freeze({ id, content, source: Object.freeze({ ...source }) });
}
