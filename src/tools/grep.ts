import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Tool, ToolContext } from "./tool.js";
import { isBlockedPath, resolveInCwd, truncate } from "./policy.js";

const MAX_FILES = 200;
const MAX_HITS = 50;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATTERN_LENGTH = 200;
const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

function argsOf(args: unknown): { pattern: string; path: string } {
  if (typeof args !== "object" || args === null) {
    throw new Error('grep requires { "pattern": string, "path"?: string }.');
  }
  const record = args as { pattern?: unknown; path?: unknown };
  if (typeof record.pattern !== "string" || record.pattern === "") {
    throw new Error('grep requires { "pattern": string, "path"?: string }.');
  }
  const path = record.path === undefined ? "." : record.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error('grep requires { "pattern": string, "path"?: string }.');
  }
  return { pattern: record.pattern, path };
}

async function collectFiles(root: string, cwd: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) {
    return;
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_FILES) {
      return;
    }
    const full = join(root, entry.name);
    // Per-file blocklist: searching "." must not leak .env / keys that
    // read_file refuses. Skip symlinks too (lexical jail, not a sandbox —
    // realpath is verified on open by resolveInCwd callers, but grep never
    // opens via resolveInCwd per file, so skip links outright).
    if (entry.isSymbolicLink() || isBlockedPath(full, cwd)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await collectFiles(full, cwd, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents under the working directory with a JavaScript RegExp. Returns file:line matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "RegExp source, e.g. 'TODO|FIXME'." },
      path: { type: "string", description: "Cwd-relative directory to search (default '.')." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<string> {
    const { pattern, path } = argsOf(args);
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `grep: pattern exceeds ${MAX_PATTERN_LENGTH} characters (ReDoS guard).`,
      );
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      throw new Error(`grep: invalid RegExp ${JSON.stringify(pattern)}.`);
    }
    const root = resolveInCwd(ctx.cwd, path);
    const cwd = resolve(ctx.cwd);
    const files: string[] = [];
    const rootStat = await stat(root).catch(() => null);
    if (rootStat?.isFile()) {
      if (isBlockedPath(root, cwd)) {
        throw new Error(
          `Path is blocked for tool access: ${JSON.stringify(path)}.`,
        );
      }
      files.push(root);
    } else {
      await collectFiles(root, cwd, files);
    }
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= MAX_HITS) {
        break;
      }
      if (isBlockedPath(file, cwd)) {
        continue;
      }
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
        continue;
      }
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null || content.includes("\0")) {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
        let matched = false;
        try {
          matched = re.test(lines[i] as string);
        } catch {
          throw new Error(`grep: pattern failed to execute (catastrophic backtracking?).`);
        }
        // Avoid stateful global/sticky regexps skipping lines.
        re.lastIndex = 0;
        if (matched) {
          const rel = file.startsWith(cwd + sep) ? file.slice(cwd.length + 1) : file;
          hits.push(`${rel}:${i + 1}:${(lines[i] as string).slice(0, 300)}`);
        }
      }
    }
    if (hits.length === 0) {
      return "(no matches)";
    }
    return truncate(hits.join("\n"));
  },
};
