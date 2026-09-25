import { describe, expect, it } from "vitest";
import { runInvestigationLoop } from "../src/agents/investigation-loop.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { Agent, AgentRun } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Message } from "../src/chat/message.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createEvaluation } from "../src/investigation/evaluation.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import { transitionHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvaluation,
  addEvidence,
  addHypothesis,
  createInvestigation,
  setInvestigationStatus,
  updateHypothesis,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "rotation-probe" } as const;

/** Deterministic per-call scripts: call N consumes scripts[N] (or silence past the end). */
class ScriptedLLM implements LLMClient {
  received: Message[][] = [];
  private calls = 0;
  constructor(private readonly scripts: string[][]) {}

  async *stream(messages: Message[]): AsyncGenerator<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    for (const chunk of this.scripts[this.calls++] ?? []) {
      yield chunk;
    }
  }

  complete(messages: Message[]): Promise<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    return Promise.resolve((this.scripts[this.calls++] ?? []).join(""));
  }
}

/** Proves non-execution loudly: any call fails the test. */
class NeverRuns implements Agent {
  readonly descriptor = { name: "never", description: "Must never run." };

  run(_input: string, _context: AgentContext): AgentRun {
    throw new Error("Agent.run must not be called");
  }
}

function proposalLines(evidenceId: string, hypothesisId: string, relation: string, reasoning: string): string[] {
  return [
    `Evidence: ${evidenceId}\n`,
    `Hypothesis: ${hypothesisId}\n`,
    `Relation: ${relation}\n`,
    `Reasoning: ${reasoning}`,
  ];
}

function seedTwoCandidates(id = "inv-1") {
  let investigation = addHypothesis(
    createInvestigation(createGoal("Understand stale execution", "goal-1"), { id }),
    createHypothesis("Rotation prevents stale execution.", "hyp-1"),
  );
  investigation = addHypothesis(
    investigation,
    createHypothesis("A stuck queue delays execution.", "hyp-2"),
  );
  return addEvidence(
    investigation,
    createEvidence("An accepted action survives generation rotation.", { ...TOOL_SOURCE }, { id: "ev-1" }),
  );
}

function generalAgent(llm: ScriptedLLM): SingleAgent {
  return new SingleAgent(llm, { name: "general", description: "General." });
}

describe("runInvestigationLoop: terminal decisions", () => {
  it("performs zero runs on finish", async () => {
    const investigation = setInvestigationStatus(seedTwoCandidates(), "succeeded");

    const result = await runInvestigationLoop(investigation, new NeverRuns(), { maxSteps: 5 });

    expect(result.stop).toBe("finished");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe("finish");
    expect(result.investigation).toBe(investigation);
  });

  it("performs zero runs on undetermined without treating it as failure", async () => {
    const investigation = createInvestigation(createGoal("Understand stale execution", "goal-1"), {
      id: "inv-empty",
    });

    const result = await runInvestigationLoop(investigation, new NeverRuns(), { maxSteps: 5 });

    expect(result.stop).toBe("undetermined");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe("undetermined");
    expect(result.investigation).toBe(investigation);
    expect(result.investigation.status).toBe("unknown");
  });

  it("rejects invalid step budgets", async () => {
    const investigation = seedTwoCandidates();

    await expect(runInvestigationLoop(investigation, new NeverRuns(), { maxSteps: -1 })).rejects.toThrow(
      /maxSteps/,
    );
    await expect(runInvestigationLoop(investigation, new NeverRuns(), { maxSteps: 1.5 })).rejects.toThrow(
      /maxSteps/,
    );
  });
});

describe("runInvestigationLoop: sequential execution", () => {
  function twoStepScripts() {
    return [
      proposalLines("ev-1", "hyp-1", "contradicts", "An accepted action survived rotation."),
      proposalLines("ev-1", "hyp-2", "supports", "The queue shows no delay for other actions."),
    ];
  }

  it("decides each iteration from the latest snapshot across two steps", async () => {
    const llm = new ScriptedLLM(twoStepScripts());
    const before = seedTwoCandidates();

    const result = await runInvestigationLoop(before, generalAgent(llm), { maxSteps: 5 });

    // Exactly one run per iteration: two executions, then undetermined.
    expect(llm.received).toHaveLength(2);
    expect(result.steps.map((s) => s.kind)).toEqual(["executed", "executed", "undetermined"]);
    // Step 1 could only target (ev-1, hyp-1) — the sole pending pair
    // in I0; step 2 could only target (ev-1, hyp-2) — the sole pair left
    // pending in I1. Each decision observed the previous iteration's
    // snapshot, not I0.
    expect(result.steps[0]).toMatchObject({ kind: "executed", action: { hypothesisId: "hyp-1" } });
    expect(result.steps[1]).toMatchObject({ kind: "executed", action: { hypothesisId: "hyp-2" } });
    expect(result.stop).toBe("undetermined");
    expect(before.hypotheses.map((h) => h.status)).toEqual(["candidate", "candidate"]);
  });

  it("changes hypothesis standing only through the domain path and accumulates history", async () => {
    const llm = new ScriptedLLM(twoStepScripts());

    const result = await runInvestigationLoop(seedTwoCandidates(), generalAgent(llm), { maxSteps: 5 });

    const standings = new Map(result.investigation.hypotheses.map((h) => [h.id, h.status]));
    expect(standings.get("hyp-1")).toBe("refuted");
    expect(standings.get("hyp-2")).toBe("supported");
    // No new evidence: evaluation interprets rather than extracts.
    expect(result.investigation.evidence.map((e) => e.id)).toEqual(["ev-1"]);
    expect(result.investigation.evaluations).toHaveLength(2);
    expect(result.investigation.executionRecords).toHaveLength(2);
    expect(result.investigation.executionRecords.every((r) => r.evidenceId === null)).toBe(true);
    expect(result.investigation.status).toBe("unknown");
  });

  it("maxSteps = 1 prevents a second execution without touching status", async () => {
    const llm = new ScriptedLLM(twoStepScripts());

    const result = await runInvestigationLoop(seedTwoCandidates(), generalAgent(llm), { maxSteps: 1 });

    expect(llm.received).toHaveLength(1);
    expect(result.steps.map((s) => s.kind)).toEqual(["executed"]);
    expect(result.stop).toBe("budget-exhausted");
    expect(result.investigation.hypotheses.map((h) => h.status)).toEqual(["refuted", "candidate"]);
    expect(result.investigation.status).toBe("unknown");
  });

  it("lets no model-generated continuation text steer the loop", async () => {    // The reasoning screams "continue", yet the loop still stops: it
    // branches on step kinds, never on message content.
    const llm = new ScriptedLLM([
      proposalLines("ev-1", "hyp-1", "contradicts", "We should continue investigating further and never stop."),
    ]);
    let investigation = addHypothesis(
      createInvestigation(createGoal("Understand stale execution", "goal-1"), { id: "inv-1" }),
      createHypothesis("Rotation prevents stale execution.", "hyp-1"),
    );
    investigation = addEvidence(
      investigation,
      createEvidence("An accepted action survives generation rotation.", { ...TOOL_SOURCE }, { id: "ev-1" }),
    );

    const result = await runInvestigationLoop(investigation, generalAgent(llm), { maxSteps: 5 });

    expect(llm.received).toHaveLength(1);
    expect(result.steps.map((s) => s.kind)).toEqual(["executed", "undetermined"]);
    expect(result.stop).toBe("undetermined");
  });
});

describe("runInvestigationLoop: step failures stop without retrying", () => {
  it("stops on empty assessment output without committing anything", async () => {
    const llm = new ScriptedLLM([[]]);
    const before = seedTwoCandidates();

    const result = await runInvestigationLoop(before, generalAgent(llm), { maxSteps: 5 });

    expect(llm.received).toHaveLength(1);
    expect(result.steps.map((s) => s.kind)).toEqual(["step-failed"]);
    expect(result.stop).toBe("step-failed");
    expect(result.investigation).toBe(before);
    expect(result.investigation.status).toBe("unknown");
  });

  it("stops on evaluation-failed recording nothing, with no verdict", async () => {
    const llm = new ScriptedLLM([["H1 is definitely false."]]);
    const before = seedTwoCandidates();
    const snapshot = structuredClone(before);

    const result = await runInvestigationLoop(before, generalAgent(llm), { maxSteps: 5 });

    expect(llm.received).toHaveLength(1);
    expect(result.steps.map((s) => s.kind)).toEqual(["step-failed"]);
    expect(result.stop).toBe("step-failed");
    // Assessment prose is not evidence: nothing is retained, no lineage
    // is recorded — yet the strongest prose claim still changes nothing.
    expect(result.investigation).toBe(before);
    expect(result.investigation.evidence).toHaveLength(1);
    expect(result.investigation.executionRecords).toHaveLength(0);
    expect(result.investigation.evaluations).toHaveLength(0);
    expect(result.investigation.hypotheses.map((h) => h.status)).toEqual(["candidate", "candidate"]);
    expect(result.investigation.status).toBe("unknown");
    expect(before).toEqual(snapshot);
  });

  it("exposes no second execution abstraction", async () => {
    const module = await import("../src/agents/investigation-loop.js");

    expect(Object.keys(module).sort()).toEqual(["runInvestigationLoop"]);
  });
});

describe("runInvestigationLoop: revisability across standings", () => {
  function settledWithFreshEvidence(
    standing: "supported" | "refuted",
    priorRelation: "supports" | "contradicts",
  ) {
    let investigation = addHypothesis(
      createInvestigation(createGoal("Understand stale execution", "goal-1"), { id: "inv-revise" }),
      createHypothesis("Rotation prevents stale execution.", "hyp-1"),
    );
    investigation = addEvidence(
      investigation,
      createEvidence("one pending action", { ...TOOL_SOURCE }, { id: "ev-1" }),
    );
    const first = createEvaluation("ev-1", "hyp-1", priorRelation, "First assessment.", "eval-1");
    investigation = addEvaluation(
      updateHypothesis(investigation, transitionHypothesis(investigation.hypotheses[0]!, standing)),
      first,
    );
    return addEvidence(
      investigation,
      createEvidence("second sighting from an independent probe", { ...TOOL_SOURCE }, { id: "ev-2" }),
    );
  }

  it("moves supported to refuted on independent contradicting evidence", async () => {
    const llm = new ScriptedLLM([
      proposalLines("ev-2", "hyp-1", "contradicts", "The second sighting contradicts it."),
    ]);

    const result = await runInvestigationLoop(
      settledWithFreshEvidence("supported", "supports"),
      generalAgent(llm),
      { maxSteps: 5 },
    );

    expect(result.steps.map((s) => s.kind)).toEqual(["executed", "undetermined"]);
    expect(result.stop).toBe("undetermined");
    expect(result.investigation.hypotheses[0]?.status).toBe("refuted");
    expect(result.investigation.evaluations.map((e) => e.id)).toEqual(["eval-1", expect.any(String)]);
    expect(result.investigation.status).toBe("unknown");
  });

  it("moves refuted to supported on independent supporting evidence", async () => {
    const llm = new ScriptedLLM([
      proposalLines("ev-2", "hyp-1", "supports", "The second sighting supports it."),
    ]);

    const result = await runInvestigationLoop(
      settledWithFreshEvidence("refuted", "contradicts"),
      generalAgent(llm),
      { maxSteps: 5 },
    );

    expect(result.steps.map((s) => s.kind)).toEqual(["executed", "undetermined"]);
    expect(result.stop).toBe("undetermined");
    expect(result.investigation.hypotheses[0]?.status).toBe("supported");
    expect(result.investigation.status).toBe("unknown");
  });
});
