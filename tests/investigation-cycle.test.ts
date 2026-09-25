import { describe, expect, it } from "vitest";
import { authorHypothesis } from "../src/agents/hypothesis-authoring.js";
import { HttpStatusExperimentExecutor } from "../src/agents/http-status-executor.js";
import { runInvestigationLoop } from "../src/agents/investigation-loop.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Message } from "../src/chat/message.js";
import { createExperiment } from "../src/investigation/experiment.js";
import { createGoal } from "../src/investigation/goal.js";
import {
  addExperiment,
  createInvestigation,
} from "../src/investigation/investigation.js";

/**
 * Complete investigation cycle, composed entirely of production
 * components with only external boundaries stubbed:
 *
 * Goal → authored Hypothesis → application Experiment →
 * configured HTTP executor → Observation → Evidence →
 * evaluated Hypothesis → natural exhaustion.
 *
 * Authority map under test: the authoring LLM supplies hypothesis
 * text only (no URL anywhere in its output); the configured target
 * URL is owned by the test harness (standing in for application
 * configuration); the stubbed fetch boundary stands in for the real
 * network. Nothing else is faked.
 */
const CONFIGURED_TARGET = "https://auth.example.test/health";

/** Authoring model: proposes exactly one hypothesis, no URLs, no verdicts. */
class AuthoringLLM implements LLMClient {
  calls: Message[][] = [];

  async *stream(_messages: Message[]): AsyncGenerator<string> {
    throw new Error("authoring uses complete(), never stream()");
  }

  async complete(messages: Message[]): Promise<string> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return "Hypothesis: The upstream authentication service is responsible for the failure.";
  }
}

/** Evaluation model: assesses the single pair named in the request prompt. */
class EvaluatingLLM implements LLMClient {
  calls: Message[][] = [];

  async *stream(messages: Message[]): AsyncGenerator<string> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const prompt = messages.map((m) => m.content).join("\n");
    const evidenceId = prompt.match(/Evidence \(([^)]+)\):/)?.[1] ?? "missing";
    const hypothesisId = prompt.match(/Hypothesis \(([^)]+)\):/)?.[1] ?? "missing";
    yield [
      `Evidence: ${evidenceId}`,
      `Hypothesis: ${hypothesisId}`,
      `Relation: supports`,
      `Reasoning: The service returned 200 as expected.`,
    ].join("\n");
  }

  async complete(_messages: Message[]): Promise<string> {
    throw new Error("evaluation uses stream(), never complete()");
  }
}

function stubFetch(status: number, calls: Array<{ url: unknown; init: unknown }>) {
  const stub = (async (url: unknown, init: unknown) => {
    calls.push({ url, init });
    return { status };
  }) as unknown as typeof fetch;
  return stub;
}

describe("complete investigation cycle", () => {
  it("runs Goal → Hypothesis → Experiment → Observation → Evidence → Evaluation → standing", async () => {
    const authoringLlm = new AuthoringLLM();
    const evaluatingLlm = new EvaluatingLLM();
    const fetchCalls: Array<{ url: unknown; init: unknown }> = [];

    // 1. Goal-only start.
    const empty = createInvestigation(
      createGoal("Determine why authentication is failing.", "goal-1"),
      { id: "inv-1" },
    );
    const emptySnapshot = structuredClone(empty);

    // 2. Authoring: LLM text becomes exactly one candidate, nothing else.
    const authored = await authorHypothesis(authoringLlm, empty, "Authentication is failing.", {
      hypothesisId: "hyp-1",
    });
    expect(authoringLlm.calls).toHaveLength(1);
    expect(authored.hypotheses).toEqual([
      {
        id: "hyp-1",
        statement: "The upstream authentication service is responsible for the failure.",
        status: "candidate",
      },
    ]);
    expect(empty).toEqual(emptySnapshot);

    // 3. Application-created experiment: descriptive procedure, no URL —
    //    executability lives in configuration, never in prose.
    const procedure = "Observe the authentication service HTTP status.";
    const withExperiment = addExperiment(
      authored,
      createExperiment("hyp-1", procedure, { id: "exp-1" }),
    );
    const experiment = withExperiment.experiments[0]!;
    expect(experiment.procedure).toBe(procedure);
    expect(experiment.falsificationId).toBeNull();
    expect(authored.experiments).toEqual([]);

    // 4. Configured executor + evaluating agent + bounded loop.
    const executor = new HttpStatusExperimentExecutor({
      url: CONFIGURED_TARGET,
      fetchImpl: stubFetch(200, fetchCalls),
    });
    const agent = new SingleAgent(evaluatingLlm, { name: "general", description: "General." });

    const result = await runInvestigationLoop(withExperiment, agent, { maxSteps: 5, executor });

    // 5. Natural exhaustion: experiment → evaluation → undetermined.
    expect(result.steps.map((s) => s.kind)).toEqual([
      "experiment-executed",
      "executed",
      "undetermined",
    ]);
    expect(result.stop).toBe("undetermined");
    expect(evaluatingLlm.calls).toHaveLength(1);

    const final = result.investigation;

    // Hypothesis: exactly one, authored as candidate, now supported
    // through the domain evaluation path.
    expect(final.hypotheses).toHaveLength(1);
    expect(final.hypotheses[0]).toMatchObject({ id: "hyp-1", status: "supported" });

    // Experiment: unchanged plan, exactly as constructed.
    expect(final.experiments).toEqual([experiment]);

    // Observation: exactly one, describing the stubbed HTTP response
    // (status plus executor-observed duration).
    expect(final.observations).toHaveLength(1);
    const observation = final.observations[0]!;
    const statusPrefix = `HTTP GET ${CONFIGURED_TARGET} returned status 200 in `;
    expect(observation.content.startsWith(statusPrefix)).toBe(true);
    expect(observation.content.endsWith("ms")).toBe(true);
    expect(observation.source).toEqual({ kind: "tool-result", tool: "http-status-probe" });

    // ExperimentExecution lineage: experiment → observation.
    expect(final.experimentExecutions).toHaveLength(1);
    expect(final.experimentExecutions[0]).toEqual({
      id: expect.any(String),
      experimentId: "exp-1",
      observationId: observation.id,
    });

    // Evidence: exactly one, promoted from the observation with
    // provenance preserved — the evaluation response minted none.
    expect(final.evidence).toHaveLength(1);
    const evidence = final.evidence[0]!;
    expect(evidence.content).toBe(observation.content);
    expect(evidence.source).toEqual({ kind: "tool-result", tool: "http-status-probe" });
    expect(evidence.hypothesisIds).toEqual([]);

    // Evaluation: exactly one, referencing produced evidence and the
    // authored hypothesis.
    expect(final.evaluations).toHaveLength(1);
    const evaluation = final.evaluations[0]!;
    expect(evaluation).toEqual({
      id: expect.any(String),
      evidenceId: evidence.id,
      hypothesisId: "hyp-1",
      relation: "supports",
      reasoning: "The service returned 200 as expected.",
    });

    // Evaluation execution lineage carries no extracted evidence.
    expect(final.executionRecords).toHaveLength(1);
    expect(final.executionRecords[0]).toMatchObject({
      actionId: expect.any(String),
      hypothesisId: "hyp-1",
      resultId: expect.any(String),
      evidenceId: null,
    });

    // Authority boundary: the model never selected the target. Neither
    // the authoring output nor the procedure names any URL; the stub
    // received exactly the configured target, once.
    const authoringText = authoringLlm.calls[0]!.map((m) => m.content).join("\n");
    expect(authoringText).not.toContain("https://");
    expect(procedure).not.toContain("https://");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(CONFIGURED_TARGET);
    expect(fetchCalls[0]?.init).toMatchObject({ method: "GET" });
    expect((fetchCalls[0]?.init as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);

    // No LLM output ever became Observation or Evidence: the only
    // observation came from `HttpStatusExperimentExecutor.execute()`
    // and the only evidence from its promotion.
    expect(final.status).toBe("unknown");

    // Snapshots: every stage preserved; the loop mutated nothing in place.
    expect(empty).toEqual(emptySnapshot);
    expect(withExperiment.experiments).toHaveLength(1);
    expect(withExperiment.evidence).toEqual([]);
    expect(withExperiment.evaluations).toEqual([]);
  });
});
