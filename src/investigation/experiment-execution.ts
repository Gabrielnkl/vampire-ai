/**
 * Which execution of which experiment produced which observation.
 *
 * Answers exactly one question: "which planned operation produced this
 * observation?" It says NOTHING about what the observation means — no
 * verdict, no standing, no evaluation lives here or follows from here.
 * Only an explicit `EvidenceEvaluation`, applied through the domain,
 * can speak to support or contradiction.
 *
 * Ids only, never member objects: `experimentId` and `observationId`
 * reuse the members' stable identities (no second execution identifier
 * exists because none is needed — the record's own `id` identifies the
 * lineage entry itself). This file imports nothing — not even sibling
 * domain types — so the shape stays free of every dependency by
 * construction, following the `ExecutionRecord` split exactly.
 *
 * Do NOT extend this record with verdicts, standings, evidence links,
 * loops, retries, or automatic follow-ups — those belong to later
 * phases, if at all.
 */
export interface ExperimentExecution {
  readonly id: string;
  readonly experimentId: string;
  readonly observationId: string;
}
