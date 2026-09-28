import { isAbsolute, normalize, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Safety policy: cwd jail + blocklist.
 *
 * - Every filesystem path resolves against `cwd`; escapes (absolute paths
 *   outside cwd, `..` traversal, symlink targets outside cwd) are rejected.
 * - Network is allowed (local-dev rule: "anything a dev can do inside this
 *   directory"); privilege/destruction and secret access are denied via the
 *   bash denylist.
 * - Secrets are protected via the read/write blocklist plus shell-pattern
 *   blocks, not via network filtering.
 * - Shell jailing is lexical (denylist), not a sandbox: it guards against
 *   accidents and casual misuse, not a determined untrusted model. Treat a
 *   model with shell access as semi-trusted.
 */

/**
 * Path segments never readable/writable through file tools. Entries match
 * a segment exactly, as a prefix (`segment.startsWith(blocked + ".")`
 * covers `.env.local`), or as a suffix (`my.env`). The audit log filename
 * is blocked so runs cannot tamper with their own trail.
 */
const BLOCKED_SEGMENTS = [
  ".env",
  ".git",
  ".ssh",
  "id_rsa",
  ".pem",
  ".key",
  ".vampire-tool.log",
];

function segmentBlocked(segment: string): boolean {
  return BLOCKED_SEGMENTS.some(
    (blocked) =>
      segment === blocked ||
      segment.startsWith(blocked + ".") ||
      segment.endsWith(blocked),
  );
}

function blockedByName(resolved: string, cwd: string): boolean {
  const rel = resolved.startsWith(cwd + sep) ? resolved.slice(cwd.length + 1) : "";
  if (rel === "") {
    return false;
  }
  return rel.split(sep).some(segmentBlocked);
}

/** True when an already-resolved absolute path is blocked. */
export function isBlockedPath(resolvedAbsolute: string, cwd: string): boolean {
  return blockedByName(normalize(resolvedAbsolute), resolve(cwd));
}

/**
 * Containment check that follows symlinks: when `resolved` (or the nearest
 * existing ancestor) exists on disk, its real path must stay under `root`.
 * Missing paths fall back to the lexical check already performed.
 */
function assertRealpathInside(resolved: string, root: string, supplied: string): void {
  let probe = resolved;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(
          `Path escapes working directory via symlink: ${JSON.stringify(supplied)}.`,
        );
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
      const parent = normalize(probe + sep + "..");
      if (parent === probe || parent.length < root.length) {
        return;
      }
      probe = parent;
    }
  }
}

/**
 * Resolve a user-supplied path against `cwd`, rejecting escapes and
 * blocked names. Throws a descriptive `Error` on violation.
 */
export function resolveInCwd(cwd: string, supplied: string): string {
  if (typeof supplied !== "string" || supplied.trim() === "") {
    throw new Error("Path must be a non-empty string.");
  }
  const root = resolve(cwd);
  const resolved = isAbsolute(supplied)
    ? normalize(supplied)
    : resolve(root, supplied);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `Path escapes working directory: ${JSON.stringify(supplied)}.`,
    );
  }
  if (blockedByName(resolved, root)) {
    throw new Error(
      `Path is blocked for tool access: ${JSON.stringify(supplied)}.`,
    );
  }
  assertRealpathInside(resolved, root, supplied);
  return resolved;
}

/** `node_modules` is readable but never writable. */
export function assertWritable(resolved: string, cwd: string): void {
  const root = resolve(cwd);
  const rel = resolved.startsWith(root + sep) ? resolved.slice(root.length + 1) : "";
  const segments = rel.split(sep);
  if (segments.includes("node_modules")) {
    throw new Error("Writes under node_modules are blocked.");
  }
}

const BASH_DENY = [
  /(^|[\s;&|()`$])sudo(\s|$)/,
  // Recursive rm aimed at root-ish targets (/, ~, $HOME, *, bare .).
  // `rm -rf ./build` stays allowed: the target must end right after ./* etc.
  /rm\s+(?=[^;&|]*-[a-zA-Z]*r)[^;&|]*\s+(\/|\~|\$HOME|\*|\.)(\s|$|;)/,
  /(^|[\s;&|()`$])(mkfs|shutdown|reboot|halt|poweroff)(\s|$|;)/,
  /(^|[\s;&|()`$])(chmod\s+.*\/|chown\s+)/,
  /(^|[\s;&|])(dd\s+|mv\s+\S+\s+\/$)/,
  // Secret access through the shell: file tools block these, so the shell
  // must too (lexical guard, not a sandbox — see module docs).
  /\.env(\.|$|["'\s])/,
  /\.git(\/|$|["'\s])/,
  /\.ssh(\/|$|["'\s])/,
  /\/etc\/(passwd|shadow|sudoers)/,
  /\.vampire-tool\.log/,
  /(^|[\s;&|()`$])(env|printenv|export\s+-p)(\s|$|;)/,
];

/** Reject privilege-escalation and destructive shell patterns. */
export function assertAllowedCommand(command: string): void {
  const cmd = command.trim();
  if (cmd === "") {
    throw new Error("Command must be a non-empty string.");
  }
  for (const pattern of BASH_DENY) {
    if (pattern.test(cmd)) {
      throw new Error(`Command blocked by policy: ${JSON.stringify(cmd.slice(0, 120))}.`);
    }
  }
}

/** Truncate tool output for events; full text still goes to the model. */
export function truncate(output: string, max = 4000): string {
  if (output.length <= max) {
    return output;
  }
  return output.slice(0, max) + `\n…[truncated ${output.length - max} chars]`;
}

/** Short preview for `tool_end` events and the TUI. */
export function preview(output: string, max = 200): string {
  const flat = output.replace(/\s+/g, " ").trim();
  if (flat.length <= max) {
    return flat;
  }
  return flat.slice(0, max) + "…";
}
