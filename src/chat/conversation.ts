import type { Message, Role } from "./message.js";

export class Conversation {
  private messages: Message[] = [];

  constructor(systemPrompt?: string) {
    if (systemPrompt !== undefined && systemPrompt.trim() !== "") {
      this.messages.push({ role: "system", content: systemPrompt });
    }
  }

  add(role: Role, content: string): void {
    this.messages.push({ role, content });
  }

  getMessages(): Message[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * Independent copy carrying the current messages. The new instance
   * shares no mutable state: `getMessages()` already returns copies, so
   * rebuilding from it isolates both directions.
   */
  clone(): Conversation {
    const copy = new Conversation();
    copy.messages = this.getMessages();
    return copy;
  }
}
