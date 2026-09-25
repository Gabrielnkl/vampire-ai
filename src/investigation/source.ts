/**
 * Provenance for observations and evidence: WHERE a piece of information
 * came from.
 *
 * Shared by `Observation` and `Evidence` so both preserve provenance in
 * the same vocabulary — but sharing the source type never promotes an
 * observation into evidence. Promotion is a deliberate, separate step
 * (creating `Evidence` from observed content), never automatic.
 *
 * Payloads reuse the repository's existing identity conventions instead
 * of inventing new ones: agent names are the same plain strings as
 * `AgentDescriptor.name` / `AgentResult.agent` (the orchestrator, not the
 * type system, decides what names resolve), and `event` carries a
 * `RuntimeEvent` type name as a plain string — the investigation domain
 * deliberately does not import or interpret chat events, so this layer
 * stays free of execution behavior. `tool` / `suite` are the producing
 * tool / test-suite names as reported by the caller.
 *
 * Do NOT add speculative fields (timestamps, confidence scores, costs,
 * spans, links) until a concrete requirement exists.
 */
export type InvestigationSource =
  | {
      kind: "agent-assertion";
      agent: string;
    }
  | {
      kind: "tool-result";
      tool: string;
    }
  | {
      kind: "test-result";
      suite: string;
    }
  | {
      kind: "runtime-event";
      event: string;
    }
  | {
      kind: "user-provided";
    };

/**
 * Guard a source's payload at the creation boundary. The discriminated
 * union already rejects unknown `kind` values statically; this rejects
 * empty producer names coming from untyped callers at runtime.
 */
export function assertValidSource(source: InvestigationSource): void {
  switch (source.kind) {
    case "agent-assertion":
      if (source.agent.trim() === "") {
        throw new Error("agent-assertion source requires a non-empty agent name");
      }
      return;
    case "tool-result":
      if (source.tool.trim() === "") {
        throw new Error("tool-result source requires a non-empty tool name");
      }
      return;
    case "test-result":
      if (source.suite.trim() === "") {
        throw new Error("test-result source requires a non-empty suite name");
      }
      return;
    case "runtime-event":
      if (source.event.trim() === "") {
        throw new Error("runtime-event source requires a non-empty event name");
      }
      return;
    case "user-provided":
      return;
  }
}
