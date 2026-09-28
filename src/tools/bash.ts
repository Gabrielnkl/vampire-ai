import { execFile } from "node:child_process";
import type { Tool, ToolContext } from "./tool.js";
import { assertAllowedCommand, truncate } from "./policy.js";

function argsOf(args: unknown): { command: string } {
  if (typeof args !== "object" || args === null) {
    throw new Error('bash requires { "command": string }.');
  }
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error('bash requires { "command": string }.');
  }
  return { command };
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "bash",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = truncate(`${stdout}${stderr}`);
        if (err) {
          const code =
            typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? `exit ${(err as { code: number }).code}`
              : (err as Error).message;
          resolve(`[${code}]\n${output === "" ? "(no output)" : output}`);
          return;
        }
        resolve(output === "" ? "(no output)" : output);
      },
    );
    child.on("error", (err) => {
      reject(new Error(`bash failed to start: ${err.message}`));
    });
  });
}

/**
 * Sandboxed shell: runs with `cwd`, a kill timeout, and a
 * privilege/destruction denylist. Network access is allowed (local-dev
 * rule); callers needing hermetic runs set policy at the composition root.
 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a bash command in the working directory (30s timeout). Use for tests, builds, and skill scripts. Network allowed; sudo/destructive commands blocked.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "Shell command to run." } },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<string> {
    const { command } = argsOf(args);
    assertAllowedCommand(command);
    try {
      return await runBash(command, ctx.cwd, ctx.timeoutMs);
    } catch (err) {
      throw new Error(`bash failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
