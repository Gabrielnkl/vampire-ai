import { describe, expect, it } from "vitest";
import { formatInvestigationResult } from "../src/app/investigation-presentation.js";
import type { InvestigationLoopResult } from "../src/agents/investigation-loop.js";
import type { Investigation } from "../src/investigation/investigation.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis, transitionHypothesis } from "../src/investigation/hypothesis.js";
import { createEvidence } from "../src/investigation/evidence.js";
import {
  addEvidence,
  addHypothesis,
  createInvestigation,
  setInvestigationStatus,
  updateHypothesis,
} from "../src/investigation/investigation.js";
import {
  createFinishAction,
  createUndeterminedAction,
} from "../src/investigation/action.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "probe" } as const;

function seedInvestigation(id = "inv-1"): Investigation {
  return createInvestigation(createGoal("Understand stale execution", "goal-1"), { id });
}

function withHypothesis(status: "candidate" | "supported" | "refuted" | "inconclusive", statement = "Rotation prevents stale execution.") {
  let investigation = addHypothesis(seedInvestigation(), createHypothesis(statement, "hyp-1"));
  if (status !== "candidate") {
    investigation = updateHypothesis(
      investigation,
      transitionHypothesis(investigation.hypotheses[0]!, status),
    );
  }
  return investigation;
}

function loopResult(
  investigation: Investigation,
  stop: InvestigationLoopResult["stop"],
): InvestigationLoopResult {
  const action =
    stop === "finished" ? createFinishAction("act-1") : createUndeterminedAction("act-1");
  const kind = stop === "finished" ? "finish" : "undetermined";
  return { investigation, steps: [{ kind, action, investigation }], stop };
}

function contents(result: InvestigationLoopResult): string[] {
  const lines = formatInvestigationResult(result);
  for (const line of lines) {
    expect(line.kind).toBe("investigation");
    expect(Object.isFrozen(line)).toBe(true);
  }
  expect(Object.isFrozen(lines)).toBe(true);
  // Pure data: JSON round-trip proves no hidden handles or domain objects.
  expect(JSON.parse(JSON.stringify(lines))).toEqual(lines);
  return lines.map((l) => l.content);
}

describe("formatInvestigationResult: standings", () => {
  it("renders supported as a non-proof conclusion", () => {
    const text = contents(loopResult(withHypothesis("supported"), "undetermined")).join("\n");

    expect(text).toContain("Investigation conclusion:");
    expect(text).toContain("currently supported");
    expect(text).toContain("Rotation prevents stale execution.");
    expect(text).toContain("not proof");
  });

  it("renders refuted without implying impossibility", () => {
    const text = contents(loopResult(withHypothesis("refuted"), "undetermined")).join("\n");

    expect(text).toContain("Investigation conclusion:");
    expect(text).toContain("currently refuted");
    expect(text).toContain("not impossible");
  });

  it("renders inconclusive as unsettled rather than failed", () => {
    const text = contents(loopResult(withHypothesis("inconclusive"), "undetermined")).join("\n");

    expect(text).toContain("Investigation conclusion:");
    expect(text).toContain("currently inconclusive");
    expect(text).toContain("not a failure");
  });

  it("renders candidate as unresolved without claiming a conclusion", () => {
    const text = contents(loopResult(withHypothesis("candidate"), "undetermined")).join("\n");

    expect(text).toContain("unresolved");
    expect(text).not.toContain("Investigation conclusion:");
  });
});

describe("formatInvestigationResult: stop reasons", () => {
  it("renders finished with the explicit status and no inferred standing", () => {
    for (const status of ["succeeded", "failed"] as const) {
      const text = contents(
        loopResult(setInvestigationStatus(withHypothesis("candidate"), status), "finished"),
      ).join("\n");

      expect(text).toContain(`finished with explicitly determined status "${status}"`);
    }
    // Finished says nothing about support or refutation by itself.
    const text = contents(
      loopResult(setInvestigationStatus(withHypothesis("candidate"), "succeeded"), "finished"),
    ).join("\n");
    expect(text).not.toContain("supported");
    expect(text).not.toContain("refuted");
  });

  it("renders undetermined as neutral, never as error", () => {
    const text = contents(loopResult(withHypothesis("candidate"), "undetermined")).join("\n");

    expect(text).toContain("no further justified investigation work was found");
    expect(text.toLowerCase()).not.toContain("error");
    expect(text.toLowerCase()).not.toContain("fail");
  });

  it("renders budget-exhausted as stopped-early, never as error", () => {
    const text = contents(loopResult(withHypothesis("candidate"), "budget-exhausted")).join("\n");

    expect(text).toContain("step budget exhausted before natural exhaustion");
    expect(text.toLowerCase()).not.toContain("error");
    expect(text.toLowerCase()).not.toContain("fail");
  });

  it("renders step-failed as failure with the recorded detail", () => {
    const investigation = withHypothesis("candidate");
    const action = createUndeterminedAction("act-1");
    const result: InvestigationLoopResult = {
      investigation,
      steps: [
        {
          kind: "step-failed",
          action,
          investigation,
          failure: "execution-failed",
          detail: "harness down",
          agentResult: null,
          evidence: null,
          record: null,
        },
      ],
      stop: "step-failed",
    };

    const text = contents(result).join("\n");

    expect(text).toContain("Investigation execution failed: harness down");
    // Failure of execution, not an epistemic verdict.
    expect(text).not.toContain("refuted");
    expect(text).not.toContain("supported");
  });
});

describe("formatInvestigationResult: collections and purity", () => {
  it("reports evidence count deterministically from the collection", () => {
    const none = contents(loopResult(seedInvestigation(), "undetermined")).join("\n");
    expect(none).toContain("Evidence considered: 0 items.");

    let one = addEvidence(
      seedInvestigation(),
      createEvidence("sighting", { ...TOOL_SOURCE }, { id: "ev-1" }),
    );
    expect(contents(loopResult(one, "undetermined")).join("\n")).toContain(
      "Evidence considered: 1 item.",
    );

    one = addEvidence(one, createEvidence("another", { ...TOOL_SOURCE }, { id: "ev-2" }));
    expect(contents(loopResult(one, "undetermined")).join("\n")).toContain(
      "Evidence considered: 2 items.",
    );
  });

  it("preserves hypothesis insertion order without ranking", () => {
    let ordered = addHypothesis(seedInvestigation("inv-3"), createHypothesis("First explanation.", "hyp-1"));
    ordered = addHypothesis(ordered, createHypothesis("Second explanation.", "hyp-2"));
    const text = contents(loopResult(ordered, "undetermined")).join("\n");

    expect(text.indexOf("First explanation.")).toBeLessThan(text.indexOf("Second explanation."));
    expect(text).not.toMatch(/winner|best|rank|priority/i);
  });

  it("invents no hypothesis when none exists", () => {
    const text = contents(loopResult(seedInvestigation(), "undetermined")).join("\n");

    expect(text).toContain("no hypotheses to assess");
    expect(text).not.toContain("Investigation conclusion:");
  });

  it("never mutates the supplied result", () => {
    const investigation = withHypothesis("supported");
    const result = loopResult(investigation, "undetermined");
    const snapshot = structuredClone(result);

    formatInvestigationResult(result);
    formatInvestigationResult(result);

    expect(result).toEqual(snapshot);
  });
});
