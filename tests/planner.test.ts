import { describe, expect, it } from "vitest";
import { DeterministicPlanner } from "../src/agents/deterministic-planner.js";
import type { PlannerInput } from "../src/agents/planner-input.js";
import type { AgentDescriptor } from "../src/agents/descriptor.js";

const GENERAL: AgentDescriptor = { name: "general", description: "General." };
const RESEARCH: AgentDescriptor = { name: "research", description: "Research." };

function planInput(
  input: string,
  messages: PlannerInput["messages"] = [],
  agents: AgentDescriptor[] = [GENERAL, RESEARCH],
): PlannerInput {
  return { input, messages, agents };
}

describe("DeterministicPlanner", () => {
  it.each([
    ["hello", "general"],
    ["", "general"],
    ["/research", "general"],
    ["/research TypeScript streams", "research"],
    ["/RESEARCH TypeScript streams", "research"],
    ["  /research TypeScript streams", "research"],
  ])("plans %j as %s", async (input, expected) => {
    const planner = new DeterministicPlanner();

    await expect(planner.plan(planInput(input))).resolves.toEqual({
      agents: [expected],
    });
  });

  it("ignores conversation history", async () => {
    const planner = new DeterministicPlanner();
    const history: PlannerInput["messages"] = [
      { role: "user", content: "research everything" },
      { role: "assistant", content: "done" },
    ];

    // Same routing with and without history: history has no effect.
    await expect(
      planner.plan(planInput("hello", history)),
    ).resolves.toEqual({ agents: ["general"] });
    await expect(
      planner.plan(planInput("/research x", history)),
    ).resolves.toEqual({ agents: ["research"] });
  });

  it("routes identically when a third agent is offered", async () => {
    const planner = new DeterministicPlanner();
    const agents = [
      GENERAL,
      RESEARCH,
      { name: "coder", description: "Writes and explains code." },
    ];

    await expect(
      planner.plan(planInput("hello", [], agents)),
    ).resolves.toEqual({ agents: ["general"] });
    await expect(
      planner.plan(planInput("/research x", [], agents)),
    ).resolves.toEqual({ agents: ["research"] });
  });

  it("falls back to general when research is not offered", async () => {
    const planner = new DeterministicPlanner();

    await expect(
      planner.plan(planInput("/research x", [], [GENERAL])),
    ).resolves.toEqual({ agents: ["general"] });
  });

  it("rejects when no executable agent is offered", async () => {
    const planner = new DeterministicPlanner();

    await expect(planner.plan(planInput("hello", [], []))).rejects.toThrow(
      /no executable agent/,
    );
  });

  it("returns only a Plan", async () => {
    const planner = new DeterministicPlanner();

    const plan = await planner.plan(planInput("/research x"));

    expect(Object.keys(plan)).toEqual(["agents"]);
  });

  it("does not modify the input", async () => {
    const planner = new DeterministicPlanner();
    const input: PlannerInput = {
      input: "/research x",
      messages: [{ role: "user", content: "before" }],
      agents: [GENERAL, RESEARCH],
    };

    await planner.plan(input);

    expect(input).toEqual({
      input: "/research x",
      messages: [{ role: "user", content: "before" }],
      agents: [GENERAL, RESEARCH],
    });
  });
});
