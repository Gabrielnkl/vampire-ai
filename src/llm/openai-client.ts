import OpenAI from "openai";
import type { Message } from "../chat/message.js";
import type { LLMClient, LLMStep, ToolCall, ToolSpec } from "./client.js";

const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAIClientOptions {
  apiKey?: string;
  model?: string;
}

type WorkingMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(options: OpenAIClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "Missing OPENAI_API_KEY. Copy .env.example to .env and set OPENAI_API_KEY.",
      );
    }
    this.model =
      options.model ?? process.env["OPENAI_MODEL"] ?? DEFAULT_MODEL;
    this.client = new OpenAI({ apiKey });
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield delta;
      }
    }
  }

  async complete(messages: Message[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    return response.choices[0]?.message.content ?? "";
  }

  /**
   * One function-calling step. `messages` here is the ephemeral working
   * transcript (base messages plus prior assistant tool_calls / tool
   * results), which carries the extra roles the canonical `Message` type
   * deliberately omits — so this method accepts the wider working type via
   * a structural cast at the call site.
   */
  async streamStep(
    messages: Message[],
    tools: readonly ToolSpec[],
  ): Promise<LLMStep> {
    const working = messages as unknown as WorkingMessage[];
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: working.map((m) => {
        if (m.role === "assistant" && m.tool_calls !== undefined) {
          return {
            role: "assistant" as const,
            content: m.content,
            tool_calls: m.tool_calls,
          };
        }
        if (m.role === "tool") {
          if (typeof m.tool_call_id !== "string" || m.tool_call_id === "") {
            throw new Error("Tool result message is missing tool_call_id.");
          }
          return {
            role: "tool" as const,
            content: m.content,
            tool_call_id: m.tool_call_id,
          };
        }
        return { role: m.role as "system" | "user" | "assistant", content: m.content };
      }),
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: (t.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
              },
            })),
            tool_choice: "auto" as const,
          }
        : {}),
    });

    const choice = response.choices[0]?.message;
    const toolCalls: ToolCall[] = (choice?.tool_calls ?? [])
      .filter((tc) => tc.type === "function")
      .map((tc, index) => ({
        id: tc.id || `call_${index}`,
        name: tc.function.name,
        arguments: tc.function.arguments ?? "{}",
      }));
    return { text: choice?.content ?? "", toolCalls };
  }
}
