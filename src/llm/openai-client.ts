import OpenAI from "openai";
import type { Message } from "../chat/message.js";
import type { LLMClient } from "./client.js";

const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAIClientOptions {
  apiKey?: string;
  model?: string;
}

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
}
