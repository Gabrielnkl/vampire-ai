/**
 * Agent Skill: a prompt package loaded from `skills/<name>/SKILL.md`.
 *
 * Follows the Agent Skills spec (see https://agentskills.io/specification):
 * a directory containing a `SKILL.md` with YAML frontmatter (`name`,
 * `description`) followed by markdown instructions. V1 supports prompt
 * content only (L1 metadata + L2 body); bundled scripts/resources (L3)
 * require a tool runtime and are out of scope.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly sourcePath: string;
}

const NAME_PATTERN = /^[a-z0-9-]+$/;
const RESERVED = new Set(["anthropic", "claude"]);
const XML_TAG_PATTERN = /<[^>]+>/;

/**
 * Parse and validate one `SKILL.md` file's contents.
 *
 * Throws a descriptive `Error` on any violation; callers that want
 * warn-and-skip behavior (like the directory loader) catch it per skill.
 * The returned object is frozen.
 */
export function parseSkillFile(
  raw: string,
  dirName: string,
  sourcePath: string,
): Skill {
  const frontmatter = extractFrontmatter(raw, sourcePath);
  const fields = parseFrontmatterFields(frontmatter.body, sourcePath);
  const name = (fields.get("name") ?? "").trim();
  const description = (fields.get("description") ?? "").trim();
  const instructions = frontmatter.instructions.trim();

  if (name === "") {
    throw new Error(`Invalid skill at ${sourcePath}: missing required "name".`);
  }
  if (name.length > 64) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "name" exceeds 64 characters.`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "name" must match [a-z0-9-] (got ${JSON.stringify(name)}).`,
    );
  }
  if (RESERVED.has(name.toLowerCase())) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "name" is reserved (got ${JSON.stringify(name)}).`,
    );
  }
  if (XML_TAG_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "name" must not contain XML tags.`,
    );
  }
  if (name !== dirName) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "name" ${JSON.stringify(name)} must match directory name ${JSON.stringify(dirName)}.`,
    );
  }
  if (description === "") {
    throw new Error(
      `Invalid skill at ${sourcePath}: missing required "description".`,
    );
  }
  if (description.length > 1024) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "description" exceeds 1024 characters.`,
    );
  }
  if (XML_TAG_PATTERN.test(description)) {
    throw new Error(
      `Invalid skill at ${sourcePath}: "description" must not contain XML tags.`,
    );
  }
  if (instructions === "") {
    throw new Error(
      `Invalid skill at ${sourcePath}: missing markdown instructions after frontmatter.`,
    );
  }

  return Object.freeze({ name, description, instructions, sourcePath });
}

function extractFrontmatter(
  raw: string,
  sourcePath: string,
): { body: string; instructions: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error(
      `Invalid skill at ${sourcePath}: SKILL.md must start with YAML frontmatter ("---").`,
    );
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (closingIndex < 0) {
    throw new Error(
      `Invalid skill at ${sourcePath}: unterminated YAML frontmatter (missing closing "---").`,
    );
  }
  return {
    body: lines.slice(1, closingIndex).join("\n"),
    instructions: lines.slice(closingIndex + 1).join("\n"),
  };
}

function parseFrontmatterFields(
  body: string,
  sourcePath: string,
): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      throw new Error(
        `Invalid skill at ${sourcePath}: malformed frontmatter line ${JSON.stringify(line)}.`,
      );
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    let value = trimmed.slice(colon + 1).trim();
    // Strip matching single/double quotes for `name: "foo"` style values.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!fields.has(key)) {
      fields.set(key, value);
    }
  }
  return fields;
}

/** Freeze a skill loaded from elsewhere (defensive copy). */
export function freezeSkill(skill: Skill): Skill {
  return Object.freeze({ ...skill });
}
