import { readdir } from "node:fs/promises";
import type { Tool, ToolContext } from "./tool.js";
import { resolveInCwd, truncate } from "./policy.js";

function argsOf(args: unknown): { path: string } {
  if (typeof args !== "object" || args === null) {
    throw new Error('list_dir requires { "path": string }.');
  }
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error('list_dir requires { "path": string }.');
  }
  return { path };
}

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List files in a directory under the working directory.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Cwd-relative directory path ('.' for root)." } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<string> {
    const { path } = argsOf(args);
    const resolved = resolveInCwd(ctx.cwd, path);
    const entries = await readdir(resolved, { withFileTypes: true }).catch((err) => {
      throw new Error(
        `list_dir failed for ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
    return truncate(lines === "" ? "(empty directory)" : lines);
  },
};
