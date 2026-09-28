import type { Message } from "../chat/message.js";

/** OpenAI function-calling tool spec surfaced to the model. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** One model-requested tool invocation. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON arguments string (parsed at execution time). */
  readonly arguments: string;
}

/** One agentic step: assistant text plus any requested tool calls. */
export interface LLMStep {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface LLMClient {
  stream(messages: Message[]): AsyncIterable<string>;

  /**
   * Single non-streaming completion for callers (like the planner) that
   * need a whole response, so they are not forced to reconstruct one
   * from the streaming protocol.
   */
  complete(messages: Message[]): Promise<string>;

  /**
   * Single agentic step with function calling: returns assistant text plus
   * any requested tool calls. Callers loop: execute tools, append results,
   * and call again until `toolCalls` is empty or a step cap is hit.
   *
   * Optional so existing test doubles (stream + complete only) keep
   * working: callers fall back to single-shot `stream()` when absent.
   */
  streamStep?(messages: Message[], tools: readonly ToolSpec[]): Promise<LLMStep>;
}
