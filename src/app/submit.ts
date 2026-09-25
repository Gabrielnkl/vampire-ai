/**
 * Minimal application input routing: normal chat versus an explicit
 * investigation request.
 *
 * Pure and total: trims leading whitespace, matches the `/investigate `
 * prefix case-insensitively, and requires a trailing space so bare
 * `/investigate`, whitespace-only remainders, and near misses
 * (`/investigator`, `/investigate-x`) stay ordinary chat. The request
 * is the stripped remainder — opaque user input, never parsed for
 * targets, experiments, or any other investigation semantics here.
 *
 * This is routing, not a command framework: one prefix, two outcomes,
 * no registry. Mirrors the existing `/research ` prefix convention
 * (case-insensitive, leading whitespace accepted, trailing space
 * required) without reusing it — `/research` stays planner routing
 * data, while this decision selects an application capability.
 */
export type SubmitRoute =
  | {
      readonly kind: "chat";
    }
  | {
      readonly kind: "investigate";
      readonly request: string;
    };

const PREFIX = "/investigate ";

export function routeSubmit(input: string): SubmitRoute {
  const trimmed = input.trimStart();
  if (trimmed.toLowerCase().startsWith(PREFIX)) {
    const request = trimmed.slice(PREFIX.length).trim();
    if (request !== "") {
      return Object.freeze({ kind: "investigate" as const, request });
    }
  }
  return Object.freeze({ kind: "chat" as const });
}
