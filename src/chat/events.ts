/**
 * Application-level runtime events consumed by the TUI: model/message
 * output ("what was said") plus tool execution ("what was done").
 *
 * Deliberately small. Orchestration lifecycle ("who is running") lives in
 * `src/agents/events.ts`; the two are combined as `AgentEvent` there.
 * Tool events carry previews only — full output goes to the model and the
 * audit log, never the event stream.
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
    }
  | {
      type: "tool_start";
      name: string;
      args: string;
    }
  | {
      type: "tool_end";
      name: string;
      ok: boolean;
      preview: string;
    };
