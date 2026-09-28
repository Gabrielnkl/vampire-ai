import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { loadSkills, loadSkillsSync, resolveSkillsDir } from "../src/skills/loader.js";

function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vampire-skills-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const GOOD = `---
name: code-review
description: Review code. Use when asked to review code.
---

# Code Review

Steps.
`;

describe("loadSkills", () => {
  it("loads valid skills and skips invalid ones with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = makeTree({
        "code-review/SKILL.md": GOOD,
        "bad/SKILL.md": "no frontmatter here",
        "empty-dir/notes.txt": "not a skill",
      });
      const skills = await loadSkills(dir);
      expect(skills.map((s) => s.name)).toEqual(["code-review"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping invalid skill"));
    } finally {
      warn.mockRestore();
    }
  });

  it("returns [] with a warning for a missing directory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const skills = await loadSkills(join(tmpdir(), "vampire-missing-skills-dir"));
      expect(skills).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
    } finally {
      warn.mockRestore();
    }
  });

  it("loadSkillsSync behaves the same", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = makeTree({ "code-review/SKILL.md": GOOD });
      expect(loadSkillsSync(dir).map((s) => s.name)).toEqual(["code-review"]);
      expect(loadSkillsSync(join(tmpdir(), "vampire-missing-sync"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveSkillsDir", () => {
  it("defaults to <cwd>/skills", () => {
    expect(resolveSkillsDir("/repo", {})).toBe(join("/repo", "skills"));
  });

  it("resolves relative SKILLS_DIR against cwd", () => {
    expect(resolveSkillsDir("/repo", { SKILLS_DIR: "custom" })).toBe(join("/repo", "custom"));
  });

  it("keeps absolute SKILLS_DIR", () => {
    expect(resolveSkillsDir("/repo", { SKILLS_DIR: "/data/skills" })).toBe("/data/skills");
  });
});
