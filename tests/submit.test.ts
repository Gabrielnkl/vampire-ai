import { describe, expect, it } from "vitest";
import { routeSubmit } from "../src/app/submit.js";

describe("routeSubmit", () => {
  it("routes ordinary input to chat", () => {
    for (const input of [
      "hello",
      "why is the server slow?",
      "   hello with leading space",
      "/research TypeScript streams",
    ]) {
      expect(routeSubmit(input)).toEqual({ kind: "chat" });
    }
  });

  it("routes an investigation request with the prefix stripped", () => {
    expect(routeSubmit("/investigate why is auth failing?")).toEqual({
      kind: "investigate",
      request: "why is auth failing?",
    });
  });

  it.each([
    ["leading whitespace", "   /investigate why is auth failing?"],
    ["uppercase command", "/INVESTIGATE why is auth failing?"],
    ["mixed case", "/InVeStIgAtE why is auth failing?"],
  ])("tolerates %s", (_label, input) => {
    expect(routeSubmit(input)).toEqual({
      kind: "investigate",
      request: "why is auth failing?",
    });
  });

  it("trims surrounding whitespace around the request", () => {
    expect(routeSubmit("/investigate    why is auth failing?   ")).toEqual({
      kind: "investigate",
      request: "why is auth failing?",
    });
  });

  it.each([
    ["bare command", "/investigate"],
    ["whitespace only", "/investigate    "],
    ["leading whitespace bare", "   /investigate"],
    ["near miss", "/investigator something"],
    ["hyphenated", "/investigate-something"],
  ])("keeps %s as ordinary chat", (_label, input) => {
    expect(routeSubmit(input)).toEqual({ kind: "chat" });
  });

  it("keeps request text opaque without reparsing", () => {
    // URLs and nested command-like text travel untouched: routing
    // never interprets the request.
    expect(routeSubmit("/investigate check https://example.com/health")).toEqual({
      kind: "investigate",
      request: "check https://example.com/health",
    });
    expect(routeSubmit("/investigate what does /investigate mean?")).toEqual({
      kind: "investigate",
      request: "what does /investigate mean?",
    });
  });

  it("returns frozen plain data", () => {
    const route = routeSubmit("/investigate why?");

    expect(Object.isFrozen(route)).toBe(true);
    expect(JSON.parse(JSON.stringify(route))).toEqual(route);
  });
});
