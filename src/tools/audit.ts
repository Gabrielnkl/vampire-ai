import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ToolAuditEntry {
  readonly ts: string;
  readonly agent: string;
  readonly tool: string;
  readonly args: string;
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Append-only JSONL audit log (out-of-band observability).
 *
 * The canonical `Conversation` stays user/assistant-only; every tool call
 * lands here with full args + output instead. Best-effort: log failures
 * never fail the tool execution itself.
 */
export async function appendToolAudit(
  logPath: string,
  entry: ToolAuditEntry,
): Promise<void> {
  if (logPath.trim() === "") {
    return;
  }
  try {
    await mkdir(dirname(logPath) === "" ? "." : dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort only.
  }
}
