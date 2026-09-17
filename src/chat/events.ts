/**
 * Application-level runtime events consumed by the TUI: model/message
 * output ("what was said").
 *
 * Deliberately small. Orchestration lifecycle ("who is running") lives in
 * `src/agents/events.ts`; the two are combined as `AgentEvent` there.
 * Do NOT add speculative agent/tool/reasoning events here.
 */
export type RuntimeEvent =
  | {
      type: "message_start";
      role: "assistant";
    }
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "message_end";
    }
  | {
      type: "error";
      error: Error;
    };
