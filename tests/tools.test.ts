import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import { grepTool } from "../src/tools/grep.js";
import { listDirTool } from "../src/tools/list-dir.js";
import { readFileTool } from "../src/tools/read-file.js";
import type { ToolContext } from "../src/tools/tool.js";
import { writeFileTool } from "../src/tools/write-file.js";

function makeCtx(dir: string): ToolContext {
  return { cwd: dir, timeoutMs: 10_000 };
}

function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vampire-tools-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("read_file", () => {
  it("reads a file and rejects escapes", async () => {
    const dir = makeTree({ "a.txt": "hello" });
    const ctx = makeCtx(dir);
    expect(await readFileTool.execute({ path: "a.txt" }, ctx)).toBe("hello");
    await expect(readFileTool.execute({ path: "../x" }, ctx)).rejects.toThrow();
    await expect(readFileTool.execute({ path: ".env" }, ctx)).rejects.toThrow();
  });

  it("rejects symlinks escaping the working directory", async () => {
    const outside = makeTree({ "secret.txt": "s3cret" });
    const dir = makeTree({ "a.txt": "hello" });
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    await expect(
      readFileTool.execute({ path: "link.txt" }, makeCtx(dir)),
    ).rejects.toThrow(/symlink/);
  });
});

describe("list_dir", () => {
  it("lists entries with trailing slash for dirs", async () => {
    const dir = makeTree({ "a.txt": "x", "sub/b.txt": "y" });
    const out = await listDirTool.execute({ path: "." }, makeCtx(dir));
    expect(out).toContain("a.txt");
    expect(out).toContain("sub/");
  });
});

describe("grep", () => {
  it("finds matches and rejects bad regexps", async () => {
    const dir = makeTree({ "a.txt": "hello\nTODO fix\nworld" });
    const out = await grepTool.execute({ pattern: "TODO", path: "." }, makeCtx(dir));
    expect(out).toContain("a.txt:2:");
    await expect(
      grepTool.execute({ pattern: "([", path: "." }, makeCtx(dir)),
    ).rejects.toThrow(/invalid RegExp/);
  });

  it("returns (no matches) when clean", async () => {
    const dir = makeTree({ "a.txt": "hello" });
    expect(await grepTool.execute({ pattern: "zzz", path: "." }, makeCtx(dir))).toBe(
      "(no matches)",
    );
  });

  it("never leaks blocked files", async () => {
    const dir = makeTree({ ".env": "SECRET=abc", "a.txt": "hello" });
    const out = await grepTool.execute({ pattern: "SECRET", path: "." }, makeCtx(dir));
    expect(out).toBe("(no matches)");
    await expect(
      grepTool.execute({ pattern: "SECRET", path: ".env" }, makeCtx(dir)),
    ).rejects.toThrow(/blocked/);
  });

  it("rejects overlong patterns", async () => {
    const dir = makeTree({ "a.txt": "hello" });
    await expect(
      grepTool.execute({ pattern: "a".repeat(201), path: "." }, makeCtx(dir)),
    ).rejects.toThrow(/exceeds/);
  });
});

describe("write_file (overwrite-only)", () => {
  it("overwrites an existing file", async () => {
    const dir = makeTree({ "a.txt": "old" });
    const out = await writeFileTool.execute(
      { path: "a.txt", content: "new" },
      makeCtx(dir),
    );
    expect(out).toContain("Wrote 3 chars");
    expect(await readFileTool.execute({ path: "a.txt" }, makeCtx(dir))).toBe("new");
  });

  it("refuses to create new files", async () => {
    const dir = makeTree({});
    await expect(
      writeFileTool.execute({ path: "new.txt", content: "x" }, makeCtx(dir)),
    ).rejects.toThrow(/does not exist/);
  });

  it("blocks node_modules writes", async () => {
    const dir = makeTree({ "node_modules/x.js": "old" });
    await expect(
      writeFileTool.execute({ path: "node_modules/x.js", content: "y" }, makeCtx(dir)),
    ).rejects.toThrow(/node_modules/);
  });

  it("blocks audit-log writes", async () => {
    const dir = makeTree({ ".vampire-tool.log": "x" });
    await expect(
      writeFileTool.execute({ path: ".vampire-tool.log", content: "y" }, makeCtx(dir)),
    ).rejects.toThrow(/blocked/);
  });
});

describe("bash", () => {
  it("runs commands and returns output", async () => {
    const dir = makeTree({});
    expect(await bashTool.execute({ command: "echo hi" }, makeCtx(dir))).toContain("hi");
  });

  it("reports nonzero exits without throwing", async () => {
    const dir = makeTree({});
    const out = await bashTool.execute({ command: "exit 3" }, makeCtx(dir));
    expect(out).toContain("exit 3");
  });

  it("blocks destructive commands", async () => {
    const dir = makeTree({});
    await expect(bashTool.execute({ command: "sudo ls" }, makeCtx(dir))).rejects.toThrow(
      /blocked/,
    );
  });
});
