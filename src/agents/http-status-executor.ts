import type { Experiment } from "../investigation/experiment.js";
import type { Observation } from "../investigation/observation.js";
import { createObservation } from "../investigation/observation.js";
import type { ExperimentExecutor } from "./experiment-executor.js";

export interface HttpStatusExecutorOptions {
  /** The single target this executor probes. Owned by configuration, never by experiment prose. */
  readonly url: string;
  /**
   * HTTP implementation, defaulting to the global `fetch`. Injected —
   * following the existing constructor-injection convention (`llm`
   * into planners/agents) — so tests can stub the network boundary
   * without real requests and without extra dependencies.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Bound in milliseconds on the HTTP operation, defaulting to
   * `DEFAULT_TIMEOUT_MS`. Every experiment execution is finite: a
   * stalled target aborts instead of holding the caller (and, through
   * it, the TUI submission path) indefinitely. The timeout bounds
   * waiting only — it never retries, reissues, or otherwise changes
   * the single-request semantics.
   */
  readonly timeoutMs?: number;
}

/** Default bound on one probe: generous for slow services and CI, finite for callers. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The first real `ExperimentExecutor`: performs a read-only HTTP GET
 * against one configured URL and records the actual response status
 * as an observation.
 *
 * Procedure vs. capability — the load-bearing separation: the
 * experiment's `procedure` is descriptive investigation intent and is
 * NEVER interpreted here. No URL extraction, no prose parsing, no
 * commands, no DSL: the configured `url` alone determines the target,
 * so a procedure naming another URL (or no URL at all) changes
 * nothing about what is fetched. The procedure says what the author
 * hoped to learn; this capability determines what actually happens.
 *
 * Request semantics, deliberately minimal: `GET`, no body, no custom
 * headers, no auth, no retries, no caching, no concurrency, default
 * redirect handling — plus one bound: every request carries
 * `AbortSignal.timeout()`, so a stalled target aborts instead of
 * holding the caller indefinitely. One capability, not an HTTP framework.
 *
 * Observation semantics: content records method, target, received
 * status, and executor-observed elapsed duration (e.g. `HTTP GET
 * https://example.com returned status 200 in 12ms`) — material
 * actually obtained, never model text. Duration means only how long
 * this request took to observe, not server time or network latency.
 * Any received response, including non-2xx statuses, is a legitimate
 * observation: a 500 was observed; it refutes nothing, fails nothing,
 * and contradicts nothing by itself. Those interpretations belong to
 * later evaluation stages. Only the absence of a response (DNS,
 * connection, or request failure) is an execution failure: the fetch
 * rejection propagates and no observation is manufactured — never a
 * fake `status 0` record.
 *
 * Provenance trust: this implementation mints exactly
 * `{ kind: "tool-result", tool: "http-status-probe" }` — fixed in
 * code, never configurable by callers, experiments, or models. The
 * executor, having actually performed the HTTP request, is the trust
 * root for that kind.
 *
 * Produces only `Observation`: no Evidence, evaluations, hypotheses,
 * lineage, or status — promotion and interpretation belong to the
 * existing pipeline (`observationToEvidence`, evaluation machinery).
 * Uses no LLM, agent, or result types; `Agent.run()` is never
 * involved.
 */
export class HttpStatusExperimentExecutor implements ExperimentExecutor {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpStatusExecutorOptions) {
    const url = options.url.trim();
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error(`Invalid executor URL: ${JSON.stringify(options.url)}`);
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(`Invalid executor URL protocol: ${JSON.stringify(options.url)}`);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid executor timeoutMs: ${JSON.stringify(options.timeoutMs)}`);
    }
    this.url = url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  async execute(_experiment: Experiment): Promise<Observation> {
    // Elapsed executor-observed time only: measured monotonically from
    // just before the request to just after it completes. This is not
    // server processing time, network latency, or any causal claim —
    // only how long this operation took to observe. Failures reject
    // before reaching here, so no duration is ever manufactured for a
    // response that does not exist.
    const start = performance.now();
    const response = await this.fetchImpl(this.url, {
      method: "GET",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const durationMs = Math.max(0, Math.round(performance.now() - start));
    return createObservation(
      `HTTP GET ${this.url} returned status ${response.status} in ${durationMs}ms`,
      {
        kind: "tool-result",
        tool: "http-status-probe",
      },
    );
  }
}
