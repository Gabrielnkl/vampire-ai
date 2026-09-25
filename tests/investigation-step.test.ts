import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInvestigationStep } from "../src/agents/investigation-step.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { Agent, AgentRun } from "../src/agents/agent.js";
import type { AgentContext } from "../src/agents/context.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Message } from "../src/chat/message.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvidence,
  addHypothesis,
  createInvestigation,
  setInvestigationStatus,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "rotation-probe" } as const;
const HYPOTHESIS_ID = "hyp-1";
const EVIDENCE_ID = "ev-1";

class FakeLLM implements LLMClient {
  received: Message[][] = [];
  constructor(private readonly chunks: string[]) {}

  async *stream(messages: Message[]): AsyncGenerator<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  complete(messages: Message[]): Promise<string> {
    this.received.push(messages.map((m) => ({ ...m })));
    return Promise.resolve(this.chunks.join(""));
  }
}

/** Proves non-execution loudly: any call fails the test. */
class NeverRuns implements Agent {
  readonly descriptor = { name: "never", description: "Must never run." };

  run(_input: string, _context: AgentContext): AgentRun {
    throw new Error("Agent.run must not be called");
  }
}

function contradictingOutput(): string[] {
  return [
    `Evidence: ${EVIDENCE_ID}\n`,
    `Hypothesis: ${HYPOTHESIS_ID}\n`,
    `Relation: contradicts\n`,
    `Reasoning: An accepted action survived generation rotation.`,
  ];
}

function seedInvestigation(id = "inv-1") {
  let investigation = addHypothesis(
    createInvestigation(createGoal("Understand stale execution", "goal-1"), { id }),
    createHypothesis(
      "pairingGeneration prevents already-accepted actions from executing after rotation.",
      HYPOTHESIS_ID,
    ),
  );
  return addEvidence(
    investigation,
    createEvidence("An accepted action survives generation rotation.", { ...TOOL_SOURCE }, { id: EVIDENCE_ID }),
  );
}

function generalAgent(llm: FakeLLM): SingleAgent {
  return new SingleAgent(llm, { name: "general", description: "General." });
}

describe("runInvestigationStep: finish", () => {
  it("runs nothing and changes nothing on a determined investigation", async () => {
    const investigation = setInvestigationStatus(seedInvestigation(), "succeeded");

    const result = await runInvestigationStep(investigation, new NeverRuns(), { actionId: "act-1" });

    expect(result.kind).toBe("finish");
    expect(result.action).toEqual({ id: "act-1", kind: "finish" });
    expect(result.investigation).toBe(investigation);
  });
});

describe("runInvestigationStep: undetermined", () => {
  it("runs nothing, fails nothing, and changes nothing", async () => {
    const investigation = createInvestigation(createGoal("Understand stale execution", "goal-1"), {
      id: "inv-empty",
    });

    const result = await runInvestigationStep(investigation, new NeverRuns(), { actionId: "act-1" });

    expect(result.kind).toBe("undetermined");
    expect(result.action).toEqual({ id: "act-1", kind: "undetermined" });
    expect(result.investigation).toBe(investigation);
  });
});

describe("runInvestigationStep: executable evaluation", () => {
  const stepIds = { actionId: "act-1", recordId: "rec-1", evaluationId: "eval-1" };

  async function executedStep() {
    const llm = new FakeLLM(contradictingOutput());
    const investigation = seedInvestigation();
    const result = await runInvestigationStep(investigation, generalAgent(llm), stepIds);
    if (result.kind !== "executed") {
      throw new Error(`expected executed, got ${result.kind}`);
    }
    return { result, llm, before: investigation };
  }

  it("decides evaluate-hypothesis and sends the agent the structured-format request", async () => {
    const { result, llm } = await executedStep();

    expect(result.action).toEqual({ id: "act-1", kind: "evaluate-hypothesis", hypothesisId: HYPOTHESIS_ID, evidenceId: EVIDENCE_ID });
    expect(llm.received).toHaveLength(1);
    const prompt = llm.received[0]!.map((m) => m.content).join("\n");
    expect(prompt).toContain(`Hypothesis (${HYPOTHESIS_ID}):`);
    // Exactly the selected pair — the agent evaluates one explicit
    // (Evidence, Hypothesis) pair, never a free choice.
    expect(prompt).toContain(`Evidence (${EVIDENCE_ID}):\nAn accepted action survives generation rotation.`);
    // The Phase 10 output contract, stated at the runtime boundary.
    for (const line of ["Evidence:", "Hypothesis:", "Relation:", "Reasoning:"]) {
      expect(prompt).toContain(line);
    }
    expect(prompt).toContain(`Hypothesis: ${HYPOTHESIS_ID}`);
  });

  it("appends the durable evaluation with null-evidence lineage", async () => {
    const { result } = await executedStep();

    // No new evidence: the agent output was assessment prose about the
    // selected pair, not world-evidence. The record says what ran.
    expect(result.evidence).toBeNull();
    expect(result.record).toEqual({
      id: "rec-1",
      actionId: "act-1",
      hypothesisId: HYPOTHESIS_ID,
      resultId: result.agentResult.id,
      evidenceId: null,
    });
    expect(result.investigation.evidence.map((e) => e.id)).toEqual([EVIDENCE_ID]);
    expect(result.investigation.evaluations.map((e) => e.id)).toEqual(["eval-1"]);
    expect(result.investigation.executionRecords).toEqual([result.record]);
  });

  it("keeps the evaluated evidence verdict-free while applying the evaluation through the domain", async () => {
    const { result, before } = await executedStep();

    expect(result.evaluation).toEqual({
      id: "eval-1",
      evidenceId: EVIDENCE_ID,
      hypothesisId: HYPOTHESIS_ID,
      relation: "contradicts",
      reasoning: "An accepted action survived generation rotation.",
    });
    const updated = result.investigation.hypotheses.find((h) => h.id === HYPOTHESIS_ID);
    expect(updated?.status).toBe("refuted");
    // Original snapshot and members untouched; status never inferred.
    expect(before.hypotheses[0]?.status).toBe("candidate");
    expect(before.evaluations).toEqual([]);
    expect(result.investigation).not.toBe(before);
    expect(result.investigation.status).toBe("unknown");
  });
});

describe("runInvestigationStep: failure boundaries", () => {
  it("reports evaluation failure without committing anything", async () => {
    // Empty assessment output is a malformed proposal, not missing
    // evidence: the selected evidence exists, but nothing interprets it.
    const investigation = seedInvestigation();

    const result = await runInvestigationStep(investigation, generalAgent(new FakeLLM([])), {
      actionId: "act-1",
    });

    expect(result.kind).toBe("step-failed");
    if (result.kind !== "step-failed") throw new Error("unreachable");
    expect(result.failure).toBe("evaluation-failed");
    expect(result.detail).not.toBe("");
    expect(result.evidence).toBeNull();
    expect(result.record).toBeNull();
    expect(result.investigation).toBe(investigation);
  });

  it("records nothing on malformed output, but changes nothing either", async () => {
    const investigation = seedInvestigation();

    const result = await runInvestigationStep(
      investigation,
      generalAgent(new FakeLLM(["H1 is definitely false."])),
      { actionId: "act-1", recordId: "rec-1" },
    );

    expect(result.kind).toBe("step-failed");
    if (result.kind !== "step-failed") throw new Error("unreachable");
    expect(result.failure).toBe("evaluation-failed");
    expect(result.detail).not.toBe("");
    // Assessment prose is not evidence: nothing is retained, no lineage
    // is recorded — yet the strongest prose claim still changes nothing.
    expect(result.evidence).toBeNull();
    expect(result.record).toBeNull();
    expect(result.investigation).toBe(investigation);
    expect(result.investigation.hypotheses[0]?.status).toBe("candidate");
    expect(result.investigation.status).toBe("unknown");
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
  });

  it("rejects evaluations retargeted at another hypothesis", async () => {
    const investigation = seedInvestigation();
    const retargeted = [
      `Evidence: ${EVIDENCE_ID}\n`,
      `Hypothesis: hyp-2\n`,
      `Relation: supports\n`,
      `Reasoning: Unrelated hypothesis.`,
    ];

    const result = await runInvestigationStep(investigation, generalAgent(new FakeLLM(retargeted)), {
      actionId: "act-1",
      recordId: "rec-1",
    });

    expect(result.kind).toBe("step-failed");
    if (result.kind !== "step-failed") throw new Error("unreachable");
    expect(result.failure).toBe("evaluation-failed");
    // The proposal names a different hypothesis than the action targets.
    expect(result.detail).toContain("hyp-2");
    expect(result.investigation).toBe(investigation);
    expect(result.investigation.hypotheses[0]?.status).toBe("candidate");
  });

  it("introduces no confidence, no second execution system, and no domain imports", async () => {
    const { result } = await (async () => {
      const llm = new FakeLLM(contradictingOutput());
      const out = await runInvestigationStep(seedInvestigation(), generalAgent(llm), {
        actionId: "act-1",
        recordId: "rec-1",
        evaluationId: "eval-1",
      });
      if (out.kind !== "executed") throw new Error(`expected executed, got ${out.kind}`);
      return { result: out };
    })();

    const serialized = JSON.stringify(result);
    for (const field of ["confidence", "probability", "certainty", "score"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    const module = await import("../src/agents/investigation-step.js");
    // Exactly the step entry points: decide-and-execute plus the
    // per-action runner it delegates experiment actions to. No runner,
    // executor, planner, or result types.
    expect(Object.keys(module).sort()).toEqual(["runExperimentStep", "runInvestigationStep"]);

    const dir = new URL("../src/investigation/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source).not.toMatch(/from ["']\.\.\/(agents|chat|llm)\//);
      expect(source).not.toMatch(/from ["'](openai|ink|react)["']/);
      expect(source).not.toContain(".run(");
    }
  });
});
