import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentResultToEvaluation } from "../src/agents/result-evaluation.js";
import { freezeResult } from "../src/agents/result.js";
import {
  createEvaluateHypothesisAction,
  createFinishAction,
} from "../src/investigation/action.js";
import { createEvidence } from "../src/investigation/evidence.js";
import { applyEvaluation } from "../src/investigation/evaluation.js";
import { createGoal } from "../src/investigation/goal.js";
import { createHypothesis } from "../src/investigation/hypothesis.js";
import {
  addEvidence,
  addHypothesis,
  createInvestigation,
} from "../src/investigation/investigation.js";

const TOOL_SOURCE = { kind: "tool-result", tool: "rotation-probe" } as const;
const HYPOTHESIS_ID = "hyp-1";
const EVIDENCE_ID = "ev-1";

function proposalText(
  evidenceId: string,
  hypothesisId: string,
  relation: string,
  reasoning: string,
): string {
  return [
    `Evidence: ${evidenceId}`,
    `Hypothesis: ${hypothesisId}`,
    `Relation: ${relation}`,
    `Reasoning: ${reasoning}`,
  ].join("\n");
}

function seedMembers() {
  const action = createEvaluateHypothesisAction(HYPOTHESIS_ID, EVIDENCE_ID, "act-1");
  const evidence = createEvidence(
    "An accepted action survives generation rotation.",
    { ...TOOL_SOURCE },
    { id: EVIDENCE_ID },
  );
  const hypothesis = createHypothesis(
    "pairingGeneration prevents already-accepted actions from executing after rotation.",
    HYPOTHESIS_ID,
  );
  return { action, evidence, hypothesis };
}

function resultWith(text: string) {
  return freezeResult("exec-1", "general", [{ role: "assistant", content: text }]);
}

describe("agentResultToEvaluation", () => {
  it("represents a valid agent evaluation proposal", () => {
    const { action, evidence } = seedMembers();

    const proposal = agentResultToEvaluation(
      action,
      resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "contradicts", "An accepted action survived rotation.")),
      evidence,
      { id: "eval-1" },
    );

    expect(proposal).toEqual({
      id: "eval-1",
      evidenceId: EVIDENCE_ID,
      hypothesisId: HYPOTHESIS_ID,
      relation: "contradicts",
      reasoning: "An accepted action survived rotation.",
    });
  });

  it.each([["supports"], ["contradicts"], ["inconclusive"]] as const)(
    "accepts the %s relation",
    (relation) => {
      const { action, evidence } = seedMembers();

      const proposal = agentResultToEvaluation(
        action,
        resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, relation, "Considered the evidence.")),
        evidence,
        { id: `eval-${relation}` },
      );

      expect(proposal.relation).toBe(relation);
    },
  );

  it("rejects invalid relations without coercion", () => {
    const { action, evidence } = seedMembers();

    expect(() =>
      agentResultToEvaluation(
        action,
        resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "proves", "Absolute proof.")),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/Invalid evaluation relation/);
  });

  it("rejects unknown evidence IDs instead of accepting invented ones", () => {
    const { action, evidence } = seedMembers();

    expect(() =>
      agentResultToEvaluation(
        action,
        resultWith(proposalText("ev-invented", HYPOTHESIS_ID, "contradicts", "Why.")),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/does not match evidence/);
  });

  it("rejects unknown hypothesis IDs", () => {
    const { action, evidence } = seedMembers();

    expect(() =>
      agentResultToEvaluation(
        action,
        resultWith(proposalText(EVIDENCE_ID, "hyp-missing", "contradicts", "Why.")),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/does not match action target/);
  });

  it("cannot silently retarget a different hypothesis than the action", () => {
    const { action, evidence } = seedMembers();

    // hyp-2 exists in principle — the adapter still refuses to aim there
    // when the action targeted hyp-1.
    expect(() =>
      agentResultToEvaluation(
        action,
        resultWith(proposalText(EVIDENCE_ID, "hyp-2", "supports", "Why.")),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/does not match action target/);
  });

  it("rejects malformed output and empty reasoning", () => {
    const { action, evidence } = seedMembers();

    // Prose without the proposal shape.
    expect(() =>
      agentResultToEvaluation(action, resultWith("H1 is definitely false."), evidence, { id: "eval-1" }),
    ).toThrow(/Malformed evaluation proposal/);
    // Missing field.
    expect(() =>
      agentResultToEvaluation(
        action,
        resultWith(`Evidence: ${EVIDENCE_ID}\nHypothesis: ${HYPOTHESIS_ID}\nRelation: supports`),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/missing field/);
    // Empty reasoning is rejected by the domain, never coerced.
    expect(() =>
      agentResultToEvaluation(
        action,
        resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "supports", "   ")),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/reasoning/);
    // Empty results contain no proposal at all.
    expect(() =>
      agentResultToEvaluation(action, freezeResult("exec-empty", "general", []), evidence, {
        id: "eval-1",
      }),
    ).toThrow(/empty agent result/);
    // Non-executing actions yield no proposals.
    expect(() =>
      agentResultToEvaluation(
        createFinishAction("act-9"),
        resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "supports", "Why.")),
        evidence,
        { id: "eval-1" },
      ),
    ).toThrow(/requests no execution/);
  });

  it("introduces no confidence or probability fields", () => {
    const { action, evidence } = seedMembers();

    const proposal = agentResultToEvaluation(
      action,
      resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "supports", "Directly observed.")),
      evidence,
      { id: "eval-1" },
    );

    for (const field of ["confidence", "probability", "certainty", "score", "truth"]) {
      expect(proposal).not.toHaveProperty(field);
    }
  });

  it("mutates nothing and changes no status by proposing", () => {
    const { action, evidence, hypothesis } = seedMembers();
    const result = resultWith(
      proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "contradicts", "An accepted action survived rotation."),
    );
    const snapshots = {
      action: structuredClone(action),
      result: structuredClone(result),
      evidence: structuredClone(evidence),
      hypothesis: structuredClone(hypothesis),
    };

    agentResultToEvaluation(action, result, evidence, { id: "eval-1" });

    expect(action).toEqual(snapshots.action);
    expect(result).toEqual(snapshots.result);
    expect(evidence).toEqual(snapshots.evidence);
    expect(hypothesis).toEqual(snapshots.hypothesis);
    expect(hypothesis.status).toBe("candidate");
    expect(evidence.hypothesisIds).toEqual([]);
  });
});

describe("proposal application through the domain", () => {
  it.each([
    ["supports", "supported"],
    ["contradicts", "refuted"],
    ["inconclusive", "inconclusive"],
  ] as const)("applies %s through applyEvaluation to reach %s", (relation, status) => {
    const { action, evidence, hypothesis } = seedMembers();

    const proposal = agentResultToEvaluation(
      action,
      resultWith(proposalText(EVIDENCE_ID, HYPOTHESIS_ID, relation, "Considered the evidence.")),
      evidence,
      { id: "eval-1" },
    );

    // The standing comes from the existing domain function — the
    // proposal itself changed nothing before this call.
    expect(hypothesis.status).toBe("candidate");
    expect(applyEvaluation(hypothesis, proposal).status).toBe(status);
  });

  it("runs the full pairingGeneration scenario to refuted via the domain", () => {
    let investigation = addEvidence(
      addHypothesis(
        createInvestigation(createGoal("Understand stale execution", "goal-1"), { id: "inv-1" }),
        createHypothesis(
          "pairingGeneration prevents already-accepted actions from executing after rotation.",
          HYPOTHESIS_ID,
        ),
      ),
      createEvidence("An accepted action survives generation rotation.", { ...TOOL_SOURCE }, { id: EVIDENCE_ID }),
    );
    const action = createEvaluateHypothesisAction(HYPOTHESIS_ID, EVIDENCE_ID, "act-1");
    const result = resultWith(
      proposalText(EVIDENCE_ID, HYPOTHESIS_ID, "contradicts", "An accepted action survived generation rotation."),
    );
    const evidence = investigation.evidence[0]!;

    const proposal = agentResultToEvaluation(action, result, evidence, { id: "eval-1" });
    const refuted = applyEvaluation(investigation.hypotheses[0]!, proposal);

    expect(refuted.status).toBe("refuted");
    expect(refuted.statement).toContain("pairingGeneration");
    // The investigation itself still knows nothing beyond the standing:
    // status changes only via the explicit status operation.
    expect(investigation.status).toBe("unknown");
  });

  it("proves prose verdicts are not state transitions", () => {
    const { evidence, hypothesis } = seedMembers();
    const action = createEvaluateHypothesisAction(HYPOTHESIS_ID, EVIDENCE_ID, "act-1");

    // The strongest possible prose claim still cannot become a proposal,
    // let alone a transition, without the validated format.
    expect(() =>
      agentResultToEvaluation(action, resultWith("H1 is definitely false."), evidence, { id: "eval-1" }),
    ).toThrow(/Malformed evaluation proposal/);
    expect(hypothesis.status).toBe("candidate");
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
