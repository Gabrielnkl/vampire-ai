import type { Message } from "../chat/message.js";

export interface LLMClient {
  stream(messages: Message[]): AsyncIterable<string>;

  /**
   * Single non-streaming completion for callers (like the planner) that
   * need a whole response, so they are not forced to reconstruct one
   * from the streaming protocol.
   */
  complete(messages: Message[]): Promise<string>;
}
