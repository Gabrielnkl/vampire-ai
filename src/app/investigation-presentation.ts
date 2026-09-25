import type { InvestigationLoopResult } from "../agents/investigation-loop.js";

/**
 * One displayable line of investigation output.
 *
 * The `kind: "investigation"` tag is the entire provenance boundary
 * at the presentation layer: it marks the content as an
 * application/investigation conclusion, structurally distinct from
 * ordinary assistant/model output. Consumers must render it as such
 * and must never re-emit it as model text (e.g. as `text_delta` or an
 * assistant `Message`). Plain data only — no domain objects cross
 * this boundary, so the TUI can consume these lines without importing
 * anything from `src/investigation/`.
 */
export interface InvestigationDisplayLine {
  readonly kind: "investigation";
  readonly content: string;
}

function line(content: string): InvestigationDisplayLine {
  return Object.freeze({ kind: "investigation" as const, content });
}

/**
 * Purely render an `InvestigationLoopResult` as display lines: no I/O,
 * no mutation, no LLM calls, no executor use, no global state. Same
 * result in, same lines out.
 *
 * Content is drawn only from fields the result already carries:
 * hypothesis statements + standings (in investigation insertion
 * order, never ranked), the evidence collection size, and the stop
 * reason. Wording follows the domain's own standing semantics —
 * supported is never proof, refuted never impossibility, inconclusive
 * never failure, candidate never a conclusion — and stop reasons are
 * never errors except genuine `step-failed` executions (whose recorded
 * `detail` is quoted verbatim, never interpreted).
 *
 * This function is intentionally unwired: it produces display data
 * for a future presentation consumer. Nothing here touches the TUI,
 * `AgentEvent`, streaming, or progress reporting.
 */
export function formatInvestigationResult(
  result: InvestigationLoopResult,
): readonly InvestigationDisplayLine[] {
  const lines: InvestigationDisplayLine[] = [];
  const { investigation } = result;

  if (investigation.hypotheses.length === 0) {
    lines.push(line("Investigation ended with no hypotheses to assess."));
  } else {
    for (const hypothesis of investigation.hypotheses) {
      switch (hypothesis.status) {
        case "supported":
          lines.push(
            line(
              `Investigation conclusion: "${hypothesis.statement}" is currently supported (a standing assessment, not proof).`,
            ),
          );
          break;
        case "refuted":
          lines.push(
            line(
              `Investigation conclusion: "${hypothesis.statement}" is currently refuted (spoken against by current evidence, not impossible).`,
            ),
          );
          break;
        case "inconclusive":
          lines.push(
            line(
              `Investigation conclusion: "${hypothesis.statement}" is currently inconclusive (the evidence does not settle it either way; not a failure).`,
            ),
          );
          break;
        case "candidate":
          lines.push(
            line(
              `Investigation: "${hypothesis.statement}" remains unresolved (candidate, not yet evaluated).`,
            ),
          );
          break;
      }
    }
  }

  const evidenceCount = investigation.evidence.length;
  lines.push(
    line(`Evidence considered: ${evidenceCount} ${evidenceCount === 1 ? "item" : "items"}.`),
  );

  switch (result.stop) {
    case "finished":
      lines.push(
        line(
          `Investigation finished with explicitly determined status "${investigation.status}".`,
        ),
      );
      break;
    case "undetermined":
      lines.push(
        line("Investigation ended: no further justified investigation work was found."),
      );
      break;
    case "budget-exhausted":
      lines.push(
        line("Investigation stopped: step budget exhausted before natural exhaustion."),
      );
      break;
    case "step-failed": {
      const failed = result.steps.find((step) => step.kind === "step-failed");
      const detail =
        failed !== undefined && failed.kind === "step-failed" && failed.detail.trim() !== ""
          ? failed.detail
          : "no detail recorded";
      lines.push(line(`Investigation execution failed: ${detail}`));
      break;
    }
  }

  return Object.freeze(lines);
}
