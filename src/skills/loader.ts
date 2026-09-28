import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Skill } from "./skill.js";
import { freezeSkill, parseSkillFile } from "./skill.js";

/**
 * Discover skills under `<dir>/SKILL.md`.
 *
 * Warn-and-skip: an invalid skill logs a warning and is skipped, never
 * aborting startup; a missing directory resolves to zero skills. Returned
 * skills are frozen, sorted by name for deterministic startup.
 */
export async function loadSkills(dir: string): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.warn(`Skills directory not found (${dir}); continuing with no skills.`);
      return [];
    }
    throw err;
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = join(dir, entry.name, "SKILL.md");
    let raw: string | null;
    try {
      raw = await readFile(skillPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }
    const skill = tryParseSkill(raw, entry.name, skillPath);
    if (skill !== null) {
      skills.push(skill);
    }
  }
  return finishSkills(skills);
}

/**
 * Synchronous variant for the composition root (`src/index.tsx` boots
 * synchronously). Same warn-and-skip semantics as `loadSkills`.
 */
export function loadSkillsSync(dir: string): Skill[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.warn(`Skills directory not found (${dir}); continuing with no skills.`);
      return [];
    }
    throw err;
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = join(dir, entry.name, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(skillPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }
    const skill = tryParseSkill(raw, entry.name, skillPath);
    if (skill !== null) {
      skills.push(skill);
    }
  }
  return finishSkills(skills);
}

/** Parse one skill, warning and returning null instead of throwing. */
function tryParseSkill(raw: string, dirName: string, skillPath: string): Skill | null {
  try {
    return parseSkillFile(raw, dirName, skillPath);
  } catch (err) {
    console.warn(
      `Skipping invalid skill ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Deterministic order + frozen copies. */
function finishSkills(skills: Skill[]): Skill[] {
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills.map(freezeSkill);
}

/**
 * Resolve the skills directory: `SKILLS_DIR` env (absolute or
 * cwd-relative) or `<cwd>/skills` by default.
 */
export function resolveSkillsDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (env["SKILLS_DIR"] ?? "").trim();
  if (configured === "") {
    return join(cwd, "skills");
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
