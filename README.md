# vampire-ai

Terminal-based LLM chat application with a streaming Ink TUI.

Architecture (dependency direction `tui → agents → llm`):

```text
Terminal
   │
   ▼
Ink TUI (src/tui/) — depends only on the Agent interface
   │
   ▼
Agent (src/agents/agent.ts)
   │
   ▼
MultiAgent (src/agents/multi-agent.ts) — itself an Agent (name
"multi", emits no events of its own); asks the injected `Planner` for a
`Plan { agents: [...] }` (ordered list; single-agent plans are the
one-element case) and runs each child sequentially, never concurrently.
Default `DeterministicPlanner` (`/research …` → research, anything else →
general, history ignored); opt-in `LLMPlanner` asks the model via
`LLMClient.complete()` for a comma-separated list with strict output
parsing (every entry must exactly match an offered descriptor name),
sending the router instruction plus conversation history plus current
input. The full plan is validated before the first child starts; empty or
unknown-containing plans execute nothing. Planners receive a
`PlannerInput` snapshot (copied messages, never the mutable
`Conversation`) taken before the current user message is recorded, so the
input appears exactly once. Each agent carries an `AgentDescriptor` (name
+ description, set at the composition root); MultiAgent hands the planner
fresh descriptor copies built from its own children — so plannable names
are always executable names — and rejects unknown plan names instead of
executing them. Plan names are plain strings; the orchestrator (not the
type system) decides executability. Forks one isolated context per
planned child (`forkContext`):
each child works on its own isolated `Conversation` copy plus a fresh
snapshot of the settled results completed earlier in the plan
(`previousResults`, one-way and read-only — children cannot reach each
other). Each settled result carries a stable per-execution `id` alongside
its producer `agent`, so repeated runs of one agent stay distinguishable
as results flow downstream; consuming a result never makes it part of the
consumer's own result. While the root conversation stays canonical — MultiAgent records
the user message up front and appends each completed child's result in
execution order. A mid-sequence child failure keeps what completed
children published (no rollback, no fabrication). No automatic merge-back
of child state. Forwards each child's events unchanged.
   │
   ├── SingleAgent "general" ───┐
   │                            │
   ├── SingleAgent "research" ───┼─► shared LLMClient → OpenAIClient
   │                            │           (src/llm/openai-client.ts)
   └── SingleAgent "coder" ──────┘   (minimal third child proving selection
                                     is composition-driven; reachable via
                                     the LLM planner — the deterministic
                                     default keeps general/research routing)
                                        │
                                        ▼
                                   OpenAI API
```

Events: `Agent.run()` returns an `AgentRun` with two channels — `events`
(`AgentEvent`s: `agent_start`/`agent_end` lifecycle brackets around
`RuntimeEvent` message output, plus `delegation_request` events an agent
may emit to name work for another agent — executed inline at most once
per requesting execution by `MultiAgent` (unknown targets and extras
surface as `error` events; nested requests stay observable but never
execute)) for streaming UI/observability, and a
separately awaitable `result` (`AgentResult { id, agent, messages }`,
frozen at settle time) for state propagation to the parent. `result.id` is
a fresh UUID per execution (so repeated runs never share identity);
`result.agent` is the producing agent's own descriptor name — descriptive
metadata, never a routing instruction. Later sequential children receive settled results as
read-only `previousResults`, rendered into their LLM request as labeled
context (`[Result 1 — general]`). Execution starts eagerly inside `run()` —
exactly once per call — so `result` settles on completion whether or not
anyone drains `events`, and late event consumers replay a local buffer.
`agent_end` means "execution ended", not "it
succeeded"; message success is signaled by `message_end`. MultiAgent
publishes the child's result into the root conversation — never
reconstructed from `text_delta`. The TUI consumes only `events` and shows
the active agent (`● research`) while streaming, labeling answers
(`Assistant [research]: …`).

The TUI never imports `openai`. Only `src/llm/openai-client.ts` does.

## Prerequisites

- Node.js v26.7.0 (or compatible modern version)
- pnpm 12.4.2

## Install dependencies

```sh
pnpm install
```

## Configure the OpenAI API key

1. Copy the example file:

   ```sh
   cp .env.example .env
   ```

2. Set your key (and optionally the model) in `.env`:

   ```env
   OPENAI_API_KEY=your-key-here
   OPENAI_MODEL=gpt-4o-mini
   PLANNER=deterministic
   ```

`OPENAI_MODEL` is optional; it defaults to `gpt-4o-mini` when unset.
`PLANNER` is optional; it defaults to `deterministic` (prefix-based
routing). Set `PLANNER=llm` to route via the model instead; any other
value fails fast at startup.
The app also works with exported environment variables instead of `.env`.

Never commit `.env` or real credentials. `.env` is git-ignored; only
`.env.example` (with no secret value) is tracked.

## Run the application

```sh
pnpm dev
```

`pnpm dev` runs without file-watching on purpose: `tsx watch` reserves
stdin keys (Return triggers a restart), which steals input from the Ink
TUI and wipes what you typed. Use plain `tsx` (or the built output) so
Ink owns the terminal.

Or build first and run the output:

```sh
pnpm build
node dist/index.js
```

Then:

1. Type a message and press Enter.
2. Watch the assistant response stream token-by-token.
3. Continue the conversation.
4. Exit with Ctrl+C or by submitting `/exit`.

While a response is streaming, new submissions are ignored.
API/network errors are shown in red inside the TUI.
Starting without `OPENAI_API_KEY` exits with a clear error message.

## Run tests

```sh
pnpm test
```

Unit tests use a fake `LLMClient`; no real OpenAI calls are made.

## Typecheck

```sh
pnpm typecheck
```

## Build

```sh
pnpm build
```
