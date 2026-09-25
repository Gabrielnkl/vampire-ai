import type { LLMClient } from "../llm/client.js";
import type { Message } from "../chat/message.js";
import type { Investigation } from "../investigation/investigation.js";
import { addHypothesis } from "../investigation/investigation.js";
import { createHypothesis } from "../investigation/hypothesis.js";

/**
 * An untrusted intermediate representation: a candidate statement as
 * extracted from model text, before any domain object exists.
 *
 * This is NOT a domain object — it carries no id, no status, no
 * provenance, no confidence, and no goal reference. It is a trusted
 * envelope around untrusted content: the parser guarantees the shape
 * (exactly one `Hypothesis:` line), never the truth, relevance, or
 * testability of the statement. Only `createHypothesis` may turn it
 * into a `Hypothesis`, and only as `candidate`.
 */
export interface HypothesisProposal {
  readonly statement: string;
}

/**
 * Parse model output into a proposal using the strict authoring
 * contract: exactly one non-blank line of the form
 * `Hypothesis: <statement>`, nothing else.
 *
 * Rejects — never repairs, never infers: empty output, a missing
 * `Hypothesis:` field, an empty statement, arbitrary prose (with or
 * without a colon), additional unsupported fields (including smuggled
 * `ID:`/`Status:`/confidence lines, which arrive as extra lines), and
 * multiple hypothesis records. Case-sensitive keys, single-line
 * trimmed values, following the `agentResultToEvaluation` parser
 * precedent.
 */
export function parseHypothesisProposal(output: string): HypothesisProposal {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    throw new Error(
      `Invalid hypothesis proposal: expected exactly one Hypothesis line, got ${lines.length} non-blank lines`,
    );
  }
  const line = lines[0] as string;
  const separator = line.indexOf(":");
  if (separator === -1) {
    throw new Error(`Malformed hypothesis proposal line: ${JSON.stringify(line)}`);
  }
  const key = line.slice(0, separator).trim();
  const statement = line.slice(separator + 1).trim();
  if (key !== "Hypothesis") {
    throw new Error(`Malformed hypothesis proposal line: ${JSON.stringify(line)}`);
  }
  if (statement === "") {
    throw new Error("Invalid hypothesis proposal: empty statement");
  }
  return { statement };
}

/**
 * Author exactly one candidate hypothesis from a user request: ask the
 * model to propose, strictly parse the response, and append the sealed
 * domain object to a new investigation snapshot.
 *
 * The prompt (built here, never hardcoded around caller state beyond
 * the investigation's own goal) instructs the model to PROPOSE a
 * candidate explanation — never to prove, evaluate, evidence, or
 * conclude anything. It requests the goal for context plus the exact
 * single-line output contract. One `complete()` call per invocation;
 * the model is called once, never in a loop.
 *
 * The only semantic claim this feature makes: "this statement has
 * been proposed as a candidate explanation." In particular it creates
 * zero Evidence (model prose is a proposal, never material — so the
 * result is never passed through `agentResultToEvidence`), zero
 * evaluations, zero experiments, zero falsifications, zero revisions,
 * and no status change; the hypothesis id comes from the domain
 * factory (or an explicit caller override for tests/rehydration),
 * never from model output. The input snapshot is never mutated: parse
 * and domain validation complete before anything is appended, so any
 * failure — LLM errors, malformed output, factory rejection — leaves
 * the original untouched (failures throw; callers treat rejection as
 * "no hypothesis authored").
 *
 * No execution provenance is recorded: authoring is not the execution
 * of an investigation action (`ExecutionRecord` requires an action, a
 * result, and — for producing executions — extracted evidence, none
 * of which exist here), so there is deliberately no record object for
 * this operation.
 *
 * Lives on the runtime side (`src/agents/`, next to the adapters) so
 * `src/investigation/` keeps importing nothing from the runtime.
 *
 * Do NOT extend this adapter with experiment/falsification authoring,
 * batch authoring, relevance scoring, confidence, or status logic —
 * those belong to later phases, if at all.
 */
export async function authorHypothesis(
  llm: LLMClient,
  investigation: Investigation,
  input: string,
  options: { hypothesisId?: string } = {},
): Promise<Investigation> {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You are proposing a candidate explanation for an investigation.\n" +
        "\n" +
        `Goal:\n${investigation.goal.description}\n` +
        "\n" +
        "Propose exactly one candidate explanation relevant to the user's request below. " +
        "You are NOT answering the investigation, proving anything, determining truth, " +
        "assigning confidence, producing evidence, evaluating evidence, or declaring any outcome — " +
        "only proposing what could be investigated.\n" +
        "\n" +
        "Respond with exactly this single line and nothing else:\n" +
        "Hypothesis: <one-line candidate explanation>",
    },
    { role: "user", content: input },
  ];
  const output = await llm.complete(messages);
  const proposal = parseHypothesisProposal(output);
  return addHypothesis(investigation, createHypothesis(proposal.statement, options.hypothesisId));
}
