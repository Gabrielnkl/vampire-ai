import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { listDirTool } from "./list-dir.js";
import { readFileTool } from "./read-file.js";
import type { Tool } from "./tool.js";
import { writeFileTool } from "./write-file.js";

/** All built-in tools, keyed by name. */
export const BUILTIN_TOOLS: Record<string, Tool> = {
  read_file: readFileTool,
  list_dir: listDirTool,
  grep: grepTool,
  write_file: writeFileTool,
  bash: bashTool,
};

/** Read-only subset safe for any agent. */
export const READ_ONLY_TOOLS: Tool[] = [readFileTool, listDirTool];

/** Research subset: read + search + shell, no writes. */
export const RESEARCH_TOOLS: Tool[] = [readFileTool, listDirTool, grepTool, bashTool];

/** Full local-dev subset for the coder agent. */
export const CODER_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  grepTool,
  writeFileTool,
  bashTool,
];

/** Pick tools by name; unknown names warn-and-skip (never throw boot). */
export function pickTools(...names: string[]): Tool[] {
  const picked: Tool[] = [];
  for (const name of names) {
    const tool = BUILTIN_TOOLS[name];
    if (tool === undefined) {
      console.warn(`Tool not found (${JSON.stringify(name)}); continuing without it.`);
      continue;
    }
    picked.push(tool);
  }
  return picked;
}
