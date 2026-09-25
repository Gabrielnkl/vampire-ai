import { randomUUID } from "node:crypto";

/**
 * A recorded change in the investigation's explanatory model: what we
 * believed before, what we believe now, which evidence forced the
 * reconsideration, and why.
 *
 * This is the engineering interpretation of an "insight" — operationally,
 * a justified transition from one explanatory model to another. The
 * important event is NOT that a new sentence was generated; it is that
 * the model changed in response to evidence.
 *
 * What it is NOT, by design:
 *
 * - NOT a hypothesis: a hypothesis says "this explanation may be true";
 *   a revision says "our model changed from A to B because evidence C
 *   exposed a limitation in A". Creating a revision creates no
 *   hypothesis and refutes none.
 * - NOT a state overwrite: `previousModel` is preserved alongside
 *   `newModel`, so the investigation can always answer "what did we
 *   believe before?" — `model = newModel` would destroy that history.
 * - NOT a verdict on other members: adding a revision changes no
 *   hypothesis standing and no investigation status. Hypothesis
 *   evaluation ("what is this hypothesis' standing?") and model
 *   revision ("how did our model change?") are related but separate
 *   operations; only an explicit evaluation changes standing.
 *
 * Both models are plain strings for this phase: the smallest
 * representation that expresses an explanatory model. No ASTs, causal
 * graphs, probabilities, or embeddings until a concrete requirement
 * exists. Likewise no confidence scores or "insight strength" — the
 * structural relationship comes first.
 *
 * `reason` explains the transition; it is NOT itself evidence, NOT
 * automatically true, and carries no `Evidence`-style provenance.
 * The cited evidence remains the source of the actual evidence — the
 * revision only references it by id, never embeds it.
 *
 * Immutable value object, frozen at creation. Revisions chain
 * (A → B, B → C) as separate records; nothing overwrites a previous
 * revision.
 *
 * Do NOT add automatic revision generation/detection, contradiction
 * detection, hypothesis replacement, or autonomous investigation here —
 * those belong to later phases.
 */
export interface ModelRevision {
  readonly id: string;
  readonly previousModel: string;
  readonly newModel: string;
  readonly triggerEvidenceIds: readonly string[];
  readonly reason: string;
}

/**
 * Seal a fresh model revision. `id` defaults to a fresh UUID; pass an
 * explicit id in tests and when rehydrating a known revision.
 *
 * At least one trigger evidence id is required: we change the model
 * because something happened that justified reconsideration — an
 * evidence-free "revision" would be an assertion without a trigger, and
 * no such need has arisen, so the requirement stands. Every cited id
 * must be non-empty.
 *
 * Identical models are rejected: `previousModel === newModel` means no
 * revision occurred.
 */
export function createModelRevision(
  previousModel: string,
  newModel: string,
  triggerEvidenceIds: readonly string[],
  reason: string,
  id: string = randomUUID(),
): ModelRevision {
  if (id.trim() === "") {
    throw new Error("ModelRevision id must be a non-empty string");
  }
  if (previousModel.trim() === "") {
    throw new Error("ModelRevision previousModel must be a non-empty string");
  }
  if (newModel.trim() === "") {
    throw new Error("ModelRevision newModel must be a non-empty string");
  }
  if (previousModel === newModel) {
    throw new Error("ModelRevision requires a change: previousModel and newModel are identical");
  }
  if (triggerEvidenceIds.length === 0) {
    throw new Error("ModelRevision requires at least one trigger evidence id");
  }
  for (const evidenceId of triggerEvidenceIds) {
    if (evidenceId.trim() === "") {
      throw new Error("ModelRevision triggerEvidenceIds must not contain empty ids");
    }
  }
  if (reason.trim() === "") {
    throw new Error("ModelRevision reason must be a non-empty string");
  }
  return Object.freeze({
    id,
    previousModel,
    newModel,
    triggerEvidenceIds: Object.freeze([...triggerEvidenceIds]),
    reason,
  });
}
