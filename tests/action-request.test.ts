import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { investigationActionToRequest } from "../src/agents/action-request.js";
import { agentResultToEvidence } from "../src/agents/result-evidence.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Message } from "../src/chat/message.js";
import {
  createEvaluateHypothesisAction,
  createFinishAction,
  createUndeterminedAction,
  decideNextInvestigationAction,
} from "../src/investigation/action.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvidence,
  addHypothesis,
  createInvestigation,
  setInvestigationStatus,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "queue-probe" } as const;

class FakeLLM implements LLMClient {
  async *stream(_messages: Message[]): AsyncGenerator<string> {
    yield "ev-1 supports the hypothesis because only one action was pending.";
  }

  complete(_messages: Message[]): Promise<string> {
    return Promise.resolve("ev-1 supports the hypothesis because only one action was pending.");
  }
}

function seedInvestigation(id = "inv-1") {
  let investigation = addHypothesis(
    createInvestigation(createGoal("Understand stale execution", "goal-1"), { id }),
    createHypothesis("Rotation prevents stale execution.", "hyp-1"),
  );
  return addEvidence(
    investigation,
    createEvidence("one pending action", { ...TOOL_SOURCE }, { id: "ev-1" }),
  );
}

describe("investigationActionToRequest", () => {
  it("produces no execution request for finish", () => {
    const investigation = setInvestigationStatus(seedInvestigation(), "succeeded");

    // Determined status is authoritative: never re-asked of an agent.
    expect(investigationActionToRequest(createFinishAction("act-1"), investigation)).toBeNull();
    expect(
      investigationActionToRequest(
        createFinishAction("act-2"),
        setInvestigationStatus(seedInvestigation(), "failed"),
      ),
    ).toBeNull();
  });

  it("produces no execution request for undetermined, without an LLM fallback", () => {
    const investigation = createInvestigation(createGoal("Understand stale execution", "goal-1"), {
      id: "inv-empty",
    });

    expect(
      investigationActionToRequest(createUndeterminedAction("act-1"), investigation),
    ).toBeNull();
  });

  it("builds the request from the selected pair only", () => {
    let investigation = seedInvestigation();
    investigation = addEvidence(
      investigation,
      createEvidence("second sighting", { ...TOOL_SOURCE }, { id: "ev-2" }),
    );

    const request = investigationActionToRequest(
      createEvaluateHypothesisAction("hyp-1", "ev-2", "act-1"),
      investigation,
    );

    expect(request).not.toBeNull();
    expect(request?.input).toContain("Hypothesis (hyp-1):\nRotation prevents stale execution.");
    // Exactly the selected evidence — no free choice among the record.
    expect(request?.input).toContain("Evidence (ev-2):\nsecond sighting");
    expect(request?.input).not.toContain("one pending action");
    expect(request?.input).not.toContain("[ev-1]");
  });

  it("resolves IDs against the given snapshot and rejects unknown ones", () => {
    const investigation = seedInvestigation();

    expect(() =>
      investigationActionToRequest(createEvaluateHypothesisAction("hyp-missing", "ev-1", "act-1"), investigation),
    ).toThrow(/Unknown hypothesis id/);
    expect(() =>
      investigationActionToRequest(createEvaluateHypothesisAction("hyp-1", "ev-missing", "act-1"), investigation),
    ).toThrow(/Unknown evidence id/);
  });

  it("supplies evidence as copied strings, not domain objects in runtime state", () => {
    const investigation = seedInvestigation();

    const request = investigationActionToRequest(
      createEvaluateHypothesisAction("hyp-1", "ev-1", "act-1"),
      investigation,
    )!;

    // Fresh isolated context: nothing shared with the investigation or
    // any prior execution.
    expect(request.context.conversation.getMessages()).toEqual([]);
    expect(request.context.previousResults).toEqual([]);
    // Evidence contents travel as prompt text; no Evidence object is
    // reachable from the request.
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(request.input).toContain("one pending action");
  });

  it("changes nothing: no standing, no evidence, no status, no snapshot mutation", () => {
    const investigation = seedInvestigation();
    const snapshot = structuredClone(investigation);

    const request = investigationActionToRequest(
      createEvaluateHypothesisAction("hyp-1", "ev-1", "act-1"),
      investigation,
    )!;

    expect(request.input).not.toContain("supported");
    expect(request.input).not.toContain("succeeded");
    expect(investigation).toEqual(snapshot);
    expect(investigation.hypotheses[0]?.status).toBe("candidate");
    expect(investigation.status).toBe("unknown");
  });

  it("reuses the existing runtime end to end, stopping validly at AgentResult", () => {
    // Full existing chain with a fake LLM: decision → request → run →
    // result. Stopping here is a complete valid state; the assertions
    // below only observe what the later phases will consume.
    const investigation = seedInvestigation();
    const action = decideNextInvestigationAction(investigation, { id: "act-1" });
    const request = investigationActionToRequest(action, investigation)!;
    const agent = new SingleAgent(new FakeLLM(), { name: "general", description: "General." });

    return (async () => {
      const run = agent.run(request.input, request.context);
      for await (const _event of run.events) {
        // Drain: the result settles independently, drained or not.
      }
      const result = await run.result;

      expect(result.agent).toBe("general");
      expect(result.messages).toHaveLength(1);

      // Existing conversion untouched: agent prose becomes an
      // unlinked agent-assertion — NOT a verdict, NOT a status change.
      const evidence = agentResultToEvidence(result, { id: "ev-2" });
      expect(evidence?.source).toEqual({ kind: "agent-assertion", agent: "general" });
      expect(evidence?.hypothesisIds).toEqual([]);
      expect(investigation.hypotheses[0]?.status).toBe("candidate");
      expect(investigation.status).toBe("unknown");
    })();
  });

  it("introduces no second execution abstraction", async () => {
    const module = await import("../src/agents/action-request.js");

    // Exactly one function export: the adapter. No runner, executor,
    // planner, client, or result types.
    expect(Object.keys(module).sort()).toEqual(["investigationActionToRequest"]);
  });

  it("keeps runtime imports out of src/investigation/*", () => {
    const dir = new URL("../src/investigation/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source).not.toMatch(/from ["']\.\.\/(agents|chat|llm)\//);
      expect(source).not.toMatch(/from ["'](openai|ink|react)["']/);
      expect(source).not.toContain(".run(");
    }
  });
});
