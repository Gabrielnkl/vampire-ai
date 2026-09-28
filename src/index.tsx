import React from "react";
import { render } from "ink";
import { Conversation } from "./chat/conversation.js";
import { SingleAgent } from "./agents/single-agent.js";
import { MultiAgent } from "./agents/multi-agent.js";
import { DeterministicPlanner } from "./agents/deterministic-planner.js";
import { LLMPlanner } from "./agents/llm-planner.js";
import type { Planner } from "./agents/planner.js";
import type { AgentContext } from "./agents/context.js";
import { OpenAIClient } from "./llm/openai-client.js";
import { loadEnvFile } from "./env.js";
import { loadSkillsSync, resolveSkillsDir } from "./skills/loader.js";
import type { Skill } from "./skills/skill.js";
import {
  CODER_TOOLS,
  READ_ONLY_TOOLS,
  RESEARCH_TOOLS,
} from "./tools/registry.js";
import type { SingleAgentToolsOptions } from "./agents/single-agent.js";
import { isAbsolute, join, resolve } from "node:path";
import App from "./tui/App.js";

loadEnvFile();

// Ink takes ownership of the terminal (raw mode) via stdin. Without a
// TTY stdin it renders one dead frame and then throws
// "Raw mode is not supported...", while typed characters echo in the
// shell uncaptured. Fail fast with an actionable message instead.
if (!process.stdin.isTTY) {
  console.error(
    "vampire-ai requires an interactive terminal (stdin is not a TTY). " +
      "Run it directly in a terminal instead of piping input to it.",
  );
  process.exit(1);
}

try {
  // Composition root: one shared Conversation/Context/LLMClient, two
  // SingleAgent children behind a MultiAgent, then the TUI.
  //
  // Both children share the same conversation (one system prompt), so mode
  // differentiation comes from the routed `/research ` prefix — which is
  // forwarded to the child unchanged — plus the combined prompt below.
  // Per-child system prompts would require separate conversations, which
  // is deliberately deferred (see MultiAgent docs).
  //
  // The TUI receives a context-bound events callback (not the raw context
  // or result contract), so it cannot tell it is talking to a MultiAgent.
  // Only `.events` is exposed: the TUI renders the stream, while result
  // publication into the root conversation happens inside MultiAgent via
  // the child's result promise.
  const conversation = new Conversation(
    "You are a helpful terminal chat assistant. Keep answers concise. " +
      "Messages beginning with /research request research-focused answers: be thorough and precise.",
  );
  const context: AgentContext = { conversation, previousResults: [] };
  const llm = new OpenAIClient();
  // Planner selection stays deterministic by default; opt into model-based
  // routing explicitly with PLANNER=llm. Unknown values fail fast rather
  // than silently changing routing behavior.
  const plannerName = (process.env["PLANNER"] ?? "deterministic")
    .trim()
    .toLowerCase();
  let planner: Planner;
  if (plannerName === "deterministic") {
    planner = new DeterministicPlanner();
  } else if (plannerName === "llm") {
    planner = new LLMPlanner(llm);
  } else {
    throw new Error(
      `Unknown PLANNER ${JSON.stringify(process.env["PLANNER"])}. Expected "deterministic" or "llm".`,
    );
  }
  // Agent identities live here, at the composition root: each agent is
  // constructed with its descriptor, which MultiAgent later surfaces to
  // the planner. Descriptions are written once, in this file — never
  // duplicated inside planners. The coder child exists to prove selection
  // is composition-driven; it is reachable via the LLM planner, while the
  // deterministic default keeps its existing general/research behavior.
  //
  // Agent-bound skills: loaded once from SKILLS_DIR (default ./skills);
  // invalid skills warn-and-skip inside the loader, missing skills bind to
  // nothing. Each agent declares its skills explicitly here.
  //
  // Agent-bound tools: per-agent allowlists declared here (general =
  // read-only, research = read+search+shell, coder = full local dev).
  // File tools are cwd-jailed (symlinks included) with a secrets blocklist
  // (`.env*`, `.git`, `.ssh`, keys, audit log); bash runs in TOOLS_CWD
  // with a privilege/destruction/secret-access denylist and a kill
  // timeout. Shell jailing is lexical, not a sandbox — a model with shell
  // access is semi-trusted. Tool transcripts stay out of the canonical
  // conversation; full args+output go to the JSONL audit log
  // (TOOL_LOG="" disables).
  const skillsDir = resolveSkillsDir();
  const skills = loadSkillsSync(skillsDir);
  const byName = new Map<string, Skill>(skills.map((s) => [s.name, s]));
  const pickSkills = (...names: string[]): Skill[] =>
    names.flatMap((name) => {
      const skill = byName.get(name);
      if (skill === undefined) {
        console.warn(`Skill not found (${JSON.stringify(name)}); continuing without it.`);
        return [];
      }
      return [skill];
    });
  const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") {
      return fallback;
    }
    // Strict: trailing garbage ("8abc") falls back instead of parsing as 8.
    if (!/^\d+$/.test(raw.trim())) {
      return fallback;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const toolsCwdRaw = (process.env["TOOLS_CWD"] ?? "").trim();
  const toolsCwd =
    toolsCwdRaw === ""
      ? process.cwd()
      : isAbsolute(toolsCwdRaw)
        ? toolsCwdRaw
        : resolve(process.cwd(), toolsCwdRaw);
  const toolsOptions: SingleAgentToolsOptions = {
    cwd: toolsCwd,
    timeoutMs: parsePositiveInt(process.env["TOOL_TIMEOUT_MS"], 30_000),
    maxSteps: parsePositiveInt(process.env["MAX_TOOL_STEPS"], 8),
    logPath:
      process.env["TOOL_LOG"] === undefined
        ? join(process.cwd(), ".vampire-tool.log")
        : process.env["TOOL_LOG"] as string,
  };
  const agent = new MultiAgent(
    {
      general: new SingleAgent(
        llm,
        {
          name: "general",
          description: "Handles ordinary conversation and general questions.",
        },
        [],
        [],
        READ_ONLY_TOOLS,
        toolsOptions,
      ),
      research: new SingleAgent(
        llm,
        {
          name: "research",
          description: "Handles requests that require research or investigation.",
        },
        [],
        [],
        RESEARCH_TOOLS,
        toolsOptions,
      ),
      coder: new SingleAgent(
        llm,
        {
          name: "coder",
          description: "Writes and explains code.",
        },
        [],
        pickSkills("code-review"),
        CODER_TOOLS,
        toolsOptions,
      ),
    },
    planner,
  );

  render(
    <App
      run={(input) => agent.run(input, context).events}
      initialMessages={conversation.getMessages()}
    />,
  );
} catch (err) {
  console.error(
    err instanceof Error ? err.message : "Failed to start application.",
  );
  process.exit(1);
}
