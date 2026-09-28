/**
 * Tool abstraction for agent-executable capabilities.
 *
 * A `Tool` is a named, JSON-schema-described function the model can invoke
 * via OpenAI function calling. Execution returns a string that is fed back
 * to the model as the tool result — never stored in the canonical
 * `Conversation` (see SingleAgent docs).
 */
export interface ToolContext {
  /** Working directory all relative paths resolve against. */
  readonly cwd: string;
  /** Per-execution timeout for slow tools (bash). */
  readonly timeoutMs: number;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object for the `arguments` payload. */
  readonly parameters: unknown;
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

/** Options bag for agent-bound tools (per-agent allowlist). */
export interface AgentToolsOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxSteps?: number;
  /** Empty string disables the audit log. */
  readonly logPath?: string;
}

export function defaultToolsOptions(): Required<AgentToolsOptions> {
  return {
    cwd: process.cwd(),
    timeoutMs: 30_000,
    maxSteps: 8,
    logPath: ".vampire-tool.log",
  };
}
