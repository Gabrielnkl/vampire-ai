import { describe, expect, it } from "vitest";
import { runAppInvestigation } from "../src/app/investigation.js";
import type { Experiment } from "../src/investigation/experiment.js";import { formatInvestigationResult } from "../src/app/investigation-presentation.js";
import type { InvestigationDisplayLine } from "../src/app/investigation-presentation.js";
import { routeSubmit } from "../src/app/submit.js";
import { SingleAgent } from "../src/agents/single-agent.js";
import type { LLMClient } from "../src/llm/client.js";
import type { Message } from "../src/chat/message.js";

const CONFIGURED_TARGET = "https://auth.example.test/health";
const DEPENDENCY_TARGET = "https://db.example.test/health";

/** Authoring model: one hypothesis line, no URLs, no verdicts. */
class FakeAuthorLLM implements LLMClient {
  calls: Message[][] = [];

  async *stream(_messages: Message[]): AsyncGenerator<string> {
    throw new Error("authoring uses complete(), never stream()");
  }

  async complete(messages: Message[]): Promise<string> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return "Hypothesis: The upstream authentication service is responsible for the failure.";
  }
}

/** Evaluation model: assesses the single pair named in the request. */
class FakeEvalLLM implements LLMClient {
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

describe("runAppInvestigation", () => {
  it("composes Goal → candidate → two experiments → observations → evidence → evaluations, then exhausts", async () => {
    const authoringLlm = new FakeAuthorLLM();
    const evaluatingLlm = new FakeEvalLLM();
    const fetchCalls: Array<{ url: unknown; init: unknown }> = [];
    const agent = new SingleAgent(evaluatingLlm, { name: "general", description: "General." });

    const result = await runAppInvestigation(authoringLlm, agent, "Authentication is failing.", {
      httpTarget: CONFIGURED_TARGET,
      dependencyHttpTarget: DEPENDENCY_TARGET,
      fetchImpl: stubFetch(200, fetchCalls),
      maxSteps: 5,
    });

    const final = result.investigation;

    // Goal carries the request; exactly one candidate was authored.
    expect(final.goal.description).toBe("Authentication is failing.");
    expect(final.hypotheses).toHaveLength(1);
    expect(final.hypotheses[0]).toMatchObject({ status: "supported" });
    expect(final.hypotheses[0]?.statement).toBe(
      "The upstream authentication service is responsible for the failure.",
    );
    const hypothesisId = final.hypotheses[0]?.id as string;

    // Exactly two application-owned experiments targeting that hypothesis,
    // in insertion order, with descriptive procedures only.
    expect(final.experiments.map((e) => e.id)).toHaveLength(2);
    const [experiment1, experiment2] = final.experiments as [Experiment, Experiment];
    expect(experiment1.hypothesisId).toBe(hypothesisId);
    expect(experiment2.hypothesisId).toBe(hypothesisId);
    expect(experiment1.falsificationId).toBeNull();
    expect(experiment2.falsificationId).toBeNull();
    expect(experiment1.procedure).not.toContain("https://");
    expect(experiment2.procedure).not.toContain("https://");
    expect(experiment1.procedure).not.toBe(experiment2.procedure);

    // Each experiment reaches only its own configured target, in
    // insertion order: primary first, dependency second.
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.url).toBe(CONFIGURED_TARGET);
    expect(fetchCalls[1]?.url).toBe(DEPENDENCY_TARGET);
    for (const call of fetchCalls) {
      expect(call.init).toMatchObject({ method: "GET" });
    }

    // Per-experiment lineage stays distinguishable by ID, not position —
    // and the two observations are independently identifiable by target.
    expect(final.observations).toHaveLength(2);
    expect(final.experimentExecutions).toHaveLength(2);
    expect(final.evidence).toHaveLength(2);
    const expectedTargets = [CONFIGURED_TARGET, DEPENDENCY_TARGET];
    for (const [index, execution] of final.experimentExecutions.entries()) {
      const experiment = final.experiments[index]!;
      const observation = final.observations[index]!;
      const evidence = final.evidence[index]!;
      expect(execution.experimentId).toBe(experiment.id);
      expect(execution.observationId).toBe(observation.id);
      expect(observation.content).toContain(expectedTargets[index] as string);
      expect(observation.content).toMatch(/in \d+ms$/);
      expect(observation.source).toEqual({ kind: "tool-result", tool: "http-status-probe" });
      expect(evidence.content).toBe(observation.content);
      expect(evidence.source).toEqual({ kind: "tool-result", tool: "http-status-probe" });
      expect(evidence.hypothesisIds).toEqual([]);
    }

    // Each new evidence created its own pending pair, and evaluating the
    // first did not consume the second — including across the standing
    // change from candidate to supported.
    expect(final.evaluations).toHaveLength(2);
    for (const [index, evaluation] of final.evaluations.entries()) {
      expect(evaluation).toMatchObject({
        evidenceId: final.evidence[index]?.id,
        hypothesisId,
        relation: "supports",
      });
    }
    expect(final.executionRecords).toHaveLength(2);
    for (const record of final.executionRecords) {
      expect(record).toMatchObject({ hypothesisId, evidenceId: null });
    }

    // Natural exhaustion, not budget: experiment → evaluate →
    // experiment → evaluate → done. No experiment ran twice.
    expect(result.steps.map((s) => s.kind)).toEqual([
      "experiment-executed",
      "executed",
      "experiment-executed",
      "executed",
      "undetermined",
    ]);
    expect(result.stop).toBe("undetermined");
    expect(final.status).toBe("unknown");

    // Authority boundary: model output never selected the target.
    const authoringText = authoringLlm.calls[0]!.map((m) => m.content).join("\n");
    expect(authoringText).not.toContain("https://");
    expect(authoringLlm.calls).toHaveLength(1);
    expect(evaluatingLlm.calls).toHaveLength(2);
  });

  it("fails fast on an invalid target before any LLM call", async () => {
    const authoringLlm = new FakeAuthorLLM();
    const agent = new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." });

    await expect(
      runAppInvestigation(authoringLlm, agent, "Authentication is failing.", {
        httpTarget: "not a url",
        dependencyHttpTarget: DEPENDENCY_TARGET,
        fetchImpl: stubFetch(200, []),
        maxSteps: 5,
      }),
    ).rejects.toThrow(/Invalid executor URL/);
    expect(authoringLlm.calls).toHaveLength(0);
  });

  it("fails fast on an invalid dependency target before any LLM call", async () => {
    const authoringLlm = new FakeAuthorLLM();
    const agent = new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." });

    await expect(
      runAppInvestigation(authoringLlm, agent, "Authentication is failing.", {
        httpTarget: CONFIGURED_TARGET,
        dependencyHttpTarget: "not a url",
        fetchImpl: stubFetch(200, []),
        maxSteps: 5,
      }),
    ).rejects.toThrow(/Invalid executor URL/);
    expect(authoringLlm.calls).toHaveLength(0);
  });
});

describe("investigation submit contract", () => {
  /**
   * Mirrors the `runInvestigation` closure wired in `src/index.tsx`:
   * stripped request in, formatted display lines out. Defined here
   * (rather than imported) because importing the entry point would
   * execute the TTY guard and `process.exit`; the shape is kept
   * identical to the production closure by inspection.
   */
  function makeRunInvestigation(
    authoringLlm: FakeAuthorLLM,
    agent: SingleAgent,
    httpTarget: string,
    fetchImpl: typeof fetch,
  ) {
    return async (request: string): Promise<readonly InvestigationDisplayLine[]> => {
      const loopResult = await runAppInvestigation(authoringLlm, agent, request, {
        httpTarget,
        dependencyHttpTarget: DEPENDENCY_TARGET,
        fetchImpl,
        maxSteps: 5,
      });
      return formatInvestigationResult(loopResult);
    };
  }

  it("routes /investigate to the callback with the stripped request", async () => {
    const authoringLlm = new FakeAuthorLLM();
    const fetchCalls: Array<{ url: unknown; init: unknown }> = [];
    const runInvestigation = makeRunInvestigation(
      authoringLlm,
      new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." }),
      "https://auth.example.test/health",
      stubFetch(200, fetchCalls),
    );

    const route = routeSubmit("/investigate Authentication is failing?");
    if (route.kind !== "investigate") throw new Error("expected investigate route");

    const lines = await runInvestigation(route.request);

    // Stripped request reached authoring; formatted lines came back.
    expect(route.request).toBe("Authentication is failing?");
    expect(authoringLlm.calls[0]!.map((m) => m.content).join("\n")).toContain(
      "Authentication is failing?",
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.kind).toBe("investigation");
    }
    // Both application experiments ran, each against its own target.
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://auth.example.test/health",
      DEPENDENCY_TARGET,
    ]);
  });

  it("never transforms investigation lines into assistant messages", async () => {
    const runInvestigation = makeRunInvestigation(
      new FakeAuthorLLM(),
      new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." }),
      "https://auth.example.test/health",
      stubFetch(200, []),
    );

    const lines = await runInvestigation("Authentication is failing?");

    for (const line of lines) {
      // No `role` field exists: structurally impossible to mistake for
      // a chat `Message`, now or if re-serialized.
      expect(line).not.toHaveProperty("role");
      expect(JSON.parse(JSON.stringify(line))).toEqual(line);
    }
  });

  it("keeps thrown application errors distinct from step failures", async () => {
    const runInvestigation = makeRunInvestigation(
      new FakeAuthorLLM(),
      new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." }),
      "not a url",
      stubFetch(200, []),
    );

    // Configuration failure rejects (application error → red error
    // lane) rather than resolving to step-failed display lines.
    await expect(runInvestigation("Authentication is failing?")).rejects.toThrow(
      /Invalid executor URL/,
    );
  });
});

describe("two-target application composition", () => {
  /** Fetch stub routing by URL so each target behaves independently. */
  function routedFetch(
    calls: Array<{ url: unknown; init: unknown }>,
    dependency: { status: number } | { fail: string },
  ) {
    return (async (url: unknown, init: unknown) => {
      calls.push({ url, init });
      if (String(url) === DEPENDENCY_TARGET) {
        if ("fail" in dependency) {
          throw new Error(dependency.fail);
        }
        return { status: dependency.status };
      }
      return { status: 200 };
    }) as unknown as typeof fetch;
  }

  function twoTargetConfig(
    fetchImpl: typeof fetch,
  ): { httpTarget: string; dependencyHttpTarget: string; fetchImpl: typeof fetch; maxSteps: number } {
    return {
      httpTarget: CONFIGURED_TARGET,
      dependencyHttpTarget: DEPENDENCY_TARGET,
      fetchImpl,
      maxSteps: 5,
    };
  }

  it("observes the dependency target for a dependency question", async () => {
    const authoringLlm = new FakeAuthorLLM();
    const fetchCalls: Array<{ url: unknown; init: unknown }> = [];
    const agent = new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." });

    const result = await runAppInvestigation(
      authoringLlm,
      agent,
      "Investigate whether an upstream dependency is causing the failure.",
      twoTargetConfig(routedFetch(fetchCalls, { status: 500 })),
    );
    const final = result.investigation;

    // Each experiment reached only its own target: primary 200s,
    // dependency 500 — no cross-target execution in either direction.
    expect(fetchCalls.map((c) => c.url)).toEqual([CONFIGURED_TARGET, DEPENDENCY_TARGET]);
    expect(final.observations.map((o) => o.content)).toEqual([
      expect.stringContaining(CONFIGURED_TARGET),
      expect.stringContaining(DEPENDENCY_TARGET),
    ]);
    expect(final.observations[1]?.content).toContain("returned status 500");
    // Both observations evaluated through the existing pair machinery.
    expect(final.evaluations.map((e) => e.evidenceId)).toEqual(
      final.evidence.map((e) => e.id),
    );
    expect(result.stop).toBe("undetermined");
    expect(final.status).toBe("unknown");
  });

  it("isolates a failing dependency target without corrupting primary results", async () => {
    const authoringLlm = new FakeAuthorLLM();
    const fetchCalls: Array<{ url: unknown; init: unknown }> = [];
    const agent = new SingleAgent(new FakeEvalLLM(), { name: "general", description: "General." });

    const result = await runAppInvestigation(
      authoringLlm,
      agent,
      "Investigate whether an upstream dependency is causing the failure.",
      twoTargetConfig(routedFetch(fetchCalls, { fail: "connection refused" })),
    );
    const final = result.investigation;

    // Primary work completed before the dependency failed: its
    // observation, evidence, and evaluation all stand.
    expect(result.stop).toBe("step-failed");
    expect(fetchCalls.map((c) => c.url)).toEqual([CONFIGURED_TARGET, DEPENDENCY_TARGET]);
    expect(final.observations).toHaveLength(1);
    expect(final.observations[0]?.content).toContain(CONFIGURED_TARGET);
    expect(final.evidence).toHaveLength(1);
    expect(final.evaluations).toHaveLength(1);
    expect(final.experimentExecutions).toHaveLength(1);
    expect(final.hypotheses[0]?.status).toBe("supported");
    // The failed dependency produced nothing: no observation, no
    // evidence, no lineage — and the investigation itself is not failed.
    expect(final.observations.some((o) => o.content.includes(DEPENDENCY_TARGET))).toBe(false);
    expect(final.status).toBe("unknown");
  });
});
