import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal .env loader: reads KEY=VALUE lines from <cwd>/.env (if present)
 * and sets them on process.env without overwriting existing values.
 * Avoids adding a dotenv dependency for two variables.
 */
export function loadEnvFile(cwd: string = process.cwd()): void {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
