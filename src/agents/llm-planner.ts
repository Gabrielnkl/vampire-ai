import type { LLMClient } from "../llm/client.js";
import type { Message } from "../chat/message.js";
import type { PlannerInput } from "./planner-input.js";
import type { Plan } from "./plan.js";
import type { Planner } from "./planner.js";

/**
 * Model-based routing behind the same `Planner` contract as
 * `DeterministicPlanner`, so the two can be compared (or swapped) without
 * changing `MultiAgent`.
 *
 * Depends only on the `LLMClient` abstraction — never the OpenAI SDK
 * directly. Builds the routing prompt from `input.agents` (never hardcoded
 * descriptions), then sends the router instruction, the supplied
 * conversation snapshot, and the current input as a single non-streaming
 * `complete()` call. Reads only its `PlannerInput` snapshot: no
 * `Conversation` access, no `AgentContext` import, no mutation of the
 * supplied messages or descriptors.
 *
 * The model output is untrusted text: a comma-separated list whose every
 * entry (trimmed, case-insensitive) must exactly match a supplied
 * descriptor name, via explicit comparison — never arbitrary property
 * access or dynamic execution. A lone name is the one-element case.
 * Anything else — prose, explanations, empty output, empty segments, or
 * a name that was not offered — rejects with `Invalid planner output`,
 * and `MultiAgent`'s existing planner-rejection path applies (no agent
 * executes).
 */
export class LLMPlanner implements Planner {
  constructor(private readonly llm: LLMClient) {}

  async plan(input: PlannerInput): Promise<Plan> {
    const agentList = input.agents
      .map((agent) => `${agent.name}:\n${agent.description}`)
      .join("\n\n");
    const returnList = input.agents.map((agent) => agent.name).join("\n");
    const messages: Message[] = [
      {
        role: "system",
        content:
          "You are an agent router.\n" +
          "\n" +
          "Available agents:\n" +
          "\n" +
          agentList +
          "\n" +
          "\n" +
          "Use the conversation history and current user request to choose the appropriate agent.\n" +
          "\n" +
          "Return ONLY a comma-separated list of one or more of:\n" +
          returnList,
      },
      ...input.messages,
      { role: "user", content: input.input },
    ];
    const raw = await this.llm.complete(messages);
    const parts = raw.split(",");
    const agents: string[] = [];
    for (const part of parts) {
      const normalized = part.trim().toLowerCase();
      const match = input.agents.find(
        (agent) => agent.name.toLowerCase() === normalized,
      );
      if (normalized === "" || !match) {
        throw new Error(
          `Invalid planner output: ${JSON.stringify(raw.slice(0, 200))}`,
        );
      }
      // The match is guaranteed to be one of the offered descriptors by
      // construction above; MultiAgent re-validates it against its
      // executable children before running anything. Order and duplicates
      // are preserved as written — the list is an execution order, not a set.
      agents.push(match.name);
    }
    return { agents };
  }
}
