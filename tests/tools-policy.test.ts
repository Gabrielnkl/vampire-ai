import { describe, expect, it } from "vitest";
import {
  assertAllowedCommand,
  assertWritable,
  preview,
  resolveInCwd,
  truncate,
} from "../src/tools/policy.js";

describe("resolveInCwd", () => {
  const cwd = "/repo";

  it("resolves relative paths inside cwd", () => {
    expect(resolveInCwd(cwd, "src/index.ts")).toBe("/repo/src/index.ts");
    expect(resolveInCwd(cwd, ".")).toBe("/repo");
  });

  it("rejects .. escapes", () => {
    expect(() => resolveInCwd(cwd, "../etc/passwd")).toThrow(/escapes/);
    expect(() => resolveInCwd(cwd, "a/../../b")).toThrow(/escapes/);
  });

  it("rejects absolute paths outside cwd", () => {
    expect(() => resolveInCwd(cwd, "/etc/passwd")).toThrow(/escapes/);
  });

  it("accepts absolute paths inside cwd", () => {
    expect(resolveInCwd(cwd, "/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("blocks secrets and vcs paths", () => {
    expect(() => resolveInCwd(cwd, ".env")).toThrow(/blocked/);
    expect(() => resolveInCwd(cwd, ".env.local")).toThrow(/blocked/);
    expect(() => resolveInCwd(cwd, ".env.production")).toThrow(/blocked/);
    expect(() => resolveInCwd(cwd, ".git/config")).toThrow(/blocked/);
    expect(() => resolveInCwd(cwd, "sub/.ssh/id_rsa")).toThrow(/blocked/);
    expect(() => resolveInCwd(cwd, ".vampire-tool.log")).toThrow(/blocked/);
  });

  it("rejects empty paths", () => {
    expect(() => resolveInCwd(cwd, "   ")).toThrow(/non-empty/);
  });
});

describe("assertWritable", () => {
  it("blocks writes under node_modules", () => {
    expect(() => assertWritable("/repo/node_modules/x.js", "/repo")).toThrow(
      /node_modules/,
    );
  });

  it("allows ordinary paths", () => {
    expect(() => assertWritable("/repo/src/a.ts", "/repo")).not.toThrow();
  });
});

describe("assertAllowedCommand", () => {
  it("blocks privilege and destruction patterns", () => {
    expect(() => assertAllowedCommand("sudo rm -rf /")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("rm -rf /")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("rm -rf .")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("rm -rf ~")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("echo hi; shutdown now")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("$(sudo id)")).toThrow(/blocked/);
  });

  it("blocks secret access through the shell", () => {
    expect(() => assertAllowedCommand("cat .env")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("cat .env.local")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("cat .git/config")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("printenv")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("cat /etc/passwd")).toThrow(/blocked/);
    expect(() => assertAllowedCommand("rm .vampire-tool.log")).toThrow(/blocked/);
  });

  it("allows ordinary dev commands", () => {
    expect(() => assertAllowedCommand("pnpm test")).not.toThrow();
    expect(() => assertAllowedCommand("ls -la")).not.toThrow();
    expect(() => assertAllowedCommand("rm -rf ./build")).not.toThrow();
    expect(() => assertAllowedCommand("echo hi")).not.toThrow();
  });

  it("rejects empty commands", () => {
    expect(() => assertAllowedCommand("  ")).toThrow(/non-empty/);
  });
});

describe("truncate/preview", () => {
  it("passes short output through", () => {
    expect(truncate("hi")).toBe("hi");
    expect(preview("hi")).toBe("hi");
  });

  it("truncates long output with a marker", () => {
    expect(truncate("a".repeat(5000)).length).toBeLessThan(5000 + 40);
    expect(truncate("a".repeat(5000))).toContain("truncated");
    expect(preview("a".repeat(500))).toContain("…");
  });
});
