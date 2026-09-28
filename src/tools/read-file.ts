import { readFile } from "node:fs/promises";
import type { Tool, ToolContext } from "./tool.js";
import { resolveInCwd, truncate } from "./policy.js";

function argsOf(args: unknown): { path: string } {
  if (typeof args !== "object" || args === null) {
    throw new Error('read_file requires { "path": string }.');
  }
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error('read_file requires { "path": string }.');
  }
  return { path };
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file under the working directory. Use for inspecting code, configs, and skill resources.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Cwd-relative file path." } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<string> {
    const { path } = argsOf(args);
    const resolved = resolveInCwd(ctx.cwd, path);
    const content = await readFile(resolved, "utf8").catch((err) => {
      throw new Error(
        `read_file failed for ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return truncate(content);
  },
};
