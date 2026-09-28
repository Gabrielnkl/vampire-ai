import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext } from "./tool.js";
import { assertWritable, resolveInCwd } from "./policy.js";

function argsOf(args: unknown): { path: string; content: string } {
  if (typeof args !== "object" || args === null) {
    throw new Error('write_file requires { "path": string, "content": string }.');
  }
  const record = args as { path?: unknown; content?: unknown };
  if (typeof record.path !== "string" || record.path.trim() === "") {
    throw new Error('write_file requires { "path": string, "content": string }.');
  }
  if (typeof record.content !== "string") {
    throw new Error('write_file requires { "path": string, "content": string }.');
  }
  return { path: record.path, content: record.content };
}

/**
 * Overwrite-only writer (clean-software default): the file must already
 * exist — read it first, then rewrite it whole. File creation is a
 * separate, explicitly-granted capability and is out of scope for V1.
 */
export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Overwrite an existing text file under the working directory. The file must exist; read it first. Cannot create new files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Cwd-relative file path (must exist)." },
      content: { type: "string", description: "Full new file content." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<string> {
    const { path, content } = argsOf(args);
    const resolved = resolveInCwd(ctx.cwd, path);
    assertWritable(resolved, ctx.cwd);
    const info = await stat(resolved).catch(() => null);
    if (info === null) {
      throw new Error(
        `write_file refused: ${JSON.stringify(path)} does not exist (creation is not allowed; read an existing file first).`,
      );
    }
    if (!info.isFile()) {
      throw new Error(`write_file refused: ${JSON.stringify(path)} is not a file.`);
    }
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8").catch((err) => {
      throw new Error(
        `write_file failed for ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return `Wrote ${content.length} chars to ${path}.`;
  },
};
