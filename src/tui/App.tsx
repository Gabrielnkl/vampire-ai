import { useState } from "react";
import type { JSX } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import type { Message } from "../chat/message.js";
import type { AgentEvent } from "../agents/events.js";

interface AppProps {
  /**
   * Context-bound agent invocation supplied by the composition root
   * (`(input) => agent.run(input, context)`).
   *
   * Why a callback instead of `agent` + `context` props: the TUI only
   * needs to invoke a run and render the resulting `AgentEvent`s.
   * Receiving the raw `AgentContext` would expose application state
   * (`Conversation` internals) to the presentation layer. Binding the
   * context at the composition root keeps the dependency `TUI → run`
   * instead of `TUI → AgentContext`.
   */
  run: (input: string) => AsyncIterable<AgentEvent>;
  initialMessages?: Message[];
}

/** Display-only message: the producing agent is attached for labeling. */
type DisplayMessage = Message & { agent?: string };

function toDisplayMessages(messages: Message[]): DisplayMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

export default function App({
  run,
  initialMessages = [],
}: AppProps): JSX.Element {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>(() =>
    toDisplayMessages(initialMessages),
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (streaming || trimmed === "") {
      return;
    }
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }

    setInput("");
    setError(null);
    setStreaming(true);
    setStreamingText("");
    setActiveAgent(null);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);

    // Presentation only: reacts to AgentEvents. The canonical assistant
    // message is accumulated and stored inside the Agent — the TUI never
    // decides what gets stored or which agent is active; the event stream
    // is the source of truth. Partial text shown here is discarded on error.
    void (async () => {
      let accumulated = "";
      let currentAgent: string | null = null;
      try {
        for await (const event of run(trimmed)) {
          switch (event.type) {
            case "agent_start":
              currentAgent = event.agent;
              setActiveAgent(event.agent);
              break;
            case "agent_end":
              setActiveAgent(null);
              break;
            case "message_start":
              accumulated = "";
              setStreamingText("");
              break;
            case "text_delta":
              accumulated += event.text;
              setStreamingText(accumulated);
              break;
            case "message_end":
              if (accumulated !== "") {
                const done = accumulated;
                const agent = currentAgent;
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant", content: done, agent: agent ?? undefined },
                ]);
              }
              setStreaming(false);
              setStreamingText("");
              break;
            case "error":
              setError(event.error.message);
              setStreaming(false);
              setStreamingText("");
              break;
          }
        }
      } catch (err) {
        // Safety net: agents report LLM failures as `error` events
        // rather than throwing, so this only covers unexpected generator bugs.
        setError(err instanceof Error ? err.message : String(err));
        setStreaming(false);
        setStreamingText("");
        setActiveAgent(null);
      }
    })();
  };

  // Coalesced input: Ink may deliver several bytes (including Enter) in
  // a single stdin chunk as one multi-character input event, which
  // ink-text-input inserts literally — it only submits on a standalone
  // Return keypress. Splitting the first completed line out here keeps
  // fast typing, pastes, and `/exit`+Enter sent together submittable.
  // A single-line box has nowhere to keep the remainder, so anything
  // after the first line break is dropped.
  const handleChange = (value: string): void => {
    const breakAt = value.search(/[\r\n]/);
    if (breakAt === -1) {
      setInput(value);
      return;
    }
    const line = value.slice(0, breakAt);
    if (streaming || line.trim() === "") {
      // Mirrors handleSubmit's ignore rules: keep the text, drop the break.
      setInput(line);
      return;
    }
    handleSubmit(line);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" paddingX={1}>
        <Text bold>TUI LLM (Ctrl+C or /exit to quit)</Text>
      </Box>

      <Box flexDirection="column" marginY={1}>
        {messages.length === 0 && !streaming ? (
          <Text dimColor>Type a message below to start chatting.</Text>
        ) : null}
        {messages.map((m, i) => (
          <Box key={i} marginBottom={1}>
            <Text bold color={m.role === "user" ? "green" : "cyan"}>
              {m.role === "user"
                ? "You: "
                : `Assistant${m.agent ? ` [${m.agent}]` : ""}: `}
            </Text>
            <Text>{m.content}</Text>
          </Box>
        ))}
        {streaming ? (
          <Box marginBottom={1}>
            <Text bold color="cyan">
              {`● ${activeAgent ?? "assistant"}: `}
            </Text>
            <Text>{streamingText ? streamingText + "▌" : "…"}</Text>
          </Box>
        ) : null}
        {error ? <Text color="red">Error: {error}</Text> : null}
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text dimColor>{"> "}</Text>
        <TextInput
          value={input}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={streaming ? "Waiting for response…" : "Type a message…"}
        />
      </Box>
    </Box>
  );
}
