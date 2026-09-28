import type { Message } from "../chat/message.js";
import type { Skill } from "./skill.js";

/**
 * Render bound skills as trailing `system` messages for the LLM request.
 *
 * Request-only context (like `previousResultsMessage` in SingleAgent):
 * the canonical `Conversation` is never modified. Returns `[]` when no
 * skills are bound so skill-free runs send exactly the request they always
 * sent. One message per skill keeps attribution explicit.
 */
export function skillInstructionsMessages(
  skills: readonly Skill[],
): Message[] {
  return skills.map((skill) => ({
    role: "system",
    content:
      `Skill "${skill.name}": ${skill.description}\n` + skill.instructions,
  }));
}
