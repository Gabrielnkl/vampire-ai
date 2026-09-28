import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../src/skills/skill.js";

const VALID = `---
name: code-review
description: Review code. Use when asked to review code.
---

# Code Review

Steps here.
`;

describe("parseSkillFile", () => {
  it("parses a valid SKILL.md", () => {
    const skill = parseSkillFile(VALID, "code-review", "skills/code-review/SKILL.md");
    expect(skill).toEqual({
      name: "code-review",
      description: "Review code. Use when asked to review code.",
      instructions: "# Code Review\n\nSteps here.",
      sourcePath: "skills/code-review/SKILL.md",
    });
    expect(Object.isFrozen(skill)).toBe(true);
  });

  it("rejects a name that does not match the directory", () => {
    expect(() => parseSkillFile(VALID, "other", "skills/other/SKILL.md")).toThrow(
      /must match directory name/,
    );
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseSkillFile("# no frontmatter", "x", "p")).toThrow(
      /must start with YAML frontmatter/,
    );
  });

  it("rejects missing description", () => {
    const raw = `---\nname: foo\n---\n\nBody\n`;
    expect(() => parseSkillFile(raw, "foo", "p")).toThrow(/missing required "description"/);
  });

  it("rejects invalid name characters", () => {
    const raw = `---\nname: Bad_Name\ndescription: Does things. Use when testing.\n---\n\nBody\n`;
    expect(() => parseSkillFile(raw, "Bad_Name", "p")).toThrow(/must match/);
  });

  it("rejects reserved names", () => {
    const raw = `---\nname: claude\ndescription: Does things. Use when testing.\n---\n\nBody\n`;
    expect(() => parseSkillFile(raw, "claude", "p")).toThrow(/reserved/);
  });

  it("rejects XML tags in description", () => {
    const raw = `---\nname: foo\ndescription: Does <b>things</b>. Use when testing.\n---\n\nBody\n`;
    expect(() => parseSkillFile(raw, "foo", "p")).toThrow(/must not contain XML/);
  });

  it("rejects overlong description", () => {
    const raw = `---\nname: foo\ndescription: ${"a".repeat(1025)}\n---\n\nBody\n`;
    expect(() => parseSkillFile(raw, "foo", "p")).toThrow(/exceeds 1024/);
  });

  it("rejects empty instructions", () => {
    const raw = `---\nname: foo\ndescription: Does things. Use when testing.\n---\n`;
    expect(() => parseSkillFile(raw, "foo", "p")).toThrow(/missing markdown instructions/);
  });
});
