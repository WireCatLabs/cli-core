import { basename } from "node:path"
import { type AgentCli, findProgram } from "../../background/schedules.js"

/**
 * Claude starts without the owner's MCP servers, skills, settings and CLAUDE.md: a run reads its instructions
 * through the CLI, and the rest was most of its starting context. Auth, `--permission-mode` and `--allowedTools` hold.
 */
const LEAN_CLAUDE = ["--tools", "Bash", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", ""]

/** What a harness's argv is built from; the schedule keeps the argv, so a harness never sees the schedule. */
interface HarnessRun {
  program: string
  prompt: string
  /** An alias or a model id; empty for the harness's own default. */
  model: string
  /** This CLI and the others the agent may run. */
  clis: readonly AgentCli[]
  /** The store's folder and every CLI's state, config and cache folders: what the agent may write. */
  folders: string[]
  leanStart: boolean
  maxCost?: number
}

interface HarnessKind {
  name: string
  /** The names it is found by on PATH, the first found wins. */
  programs: readonly string[]
  /** The model a new schedule runs on; empty for the harness's own default. */
  model: string
  /** It reports what a run cost, so the cost caps can stop it; one that does not is never stopped by cost. */
  reportsCost: boolean
  /**
   * The harness itself holds the agent to the CLIs' commands (claude) or to their folders (codex's sandbox). Any other
   * approves every command in its one-shot mode, and only `<PREFIX>_READ_ONLY`, a variable it could unset, stops a send.
   */
  restricted: boolean
  argv(run: HarnessRun): string[]
}

const modelFlag = (flag: string, model: string) => (model ? [flag, model] : [])

/**
 * The coding agents a schedule may start, by the ids WireCat Desktop's Agents page uses. Only agents whose vendor
 * documents a one-shot mode that answers on stdout and exits are here; GLM has no agent CLI of its own, Z.ai runs it inside these agents.
 */
const AGENT_HARNESSES = {
  // https://code.claude.com/docs/en/headless
  claude: {
    name: "Claude Code",
    programs: ["claude"],
    // A mid-tier model by default.
    model: "sonnet",
    reportsCost: true,
    restricted: true,
    argv: ({ program, prompt, model, clis, leanStart, maxCost }) => [
      program,
      "-p",
      prompt,
      // The owner's own settings may let every tool run (bypassPermissions); here only the CLI may.
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ...clis.map((one) => `Bash(${one.command}:*)`),
      "--no-session-persistence",
      ...modelFlag("--model", model),
      ...(leanStart ? LEAN_CLAUDE : []),
      ...(maxCost ? ["--max-budget-usd", String(maxCost)] : []),
    ],
  },
  // https://learn.chatgpt.com/docs/non-interactive-mode
  codex: {
    name: "Codex",
    programs: ["codex"],
    // No alias of claude's tier, so codex's own default.
    model: "",
    reportsCost: false,
    restricted: true,
    argv: ({ program, prompt, model, folders }) => [
      program,
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      // The CLIs reach their provider and write the store and their own state, and nothing else.
      "-c",
      "sandbox_workspace_write.network_access=true",
      ...modelFlag("--model", model),
      ...folders.flatMap((dir) => ["--add-dir", dir]),
      prompt,
    ],
  },
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
  gemini: {
    name: "Gemini CLI",
    programs: ["gemini"],
    model: "",
    reportsCost: false,
    restricted: false,
    // A one-shot run cannot answer a prompt to approve, so every tool runs.
    argv: ({ program, prompt, model }) => [program, "-p", prompt, "--approval-mode", "yolo", ...modelFlag("-m", model)],
  },
  // https://cursor.com/docs/cli/headless
  cursor: {
    name: "Cursor",
    // `cursor` alone starts the editor; the agent's own program was `cursor-agent` and is now `agent`.
    programs: ["cursor-agent", "agent"],
    model: "",
    reportsCost: false,
    restricted: false,
    argv: ({ program, prompt, model }) => [
      program,
      "-p",
      prompt,
      "--force",
      "--trust",
      "--output-format",
      "text",
      ...modelFlag("--model", model),
    ],
  },
  // https://opencode.ai/docs/cli
  opencode: {
    name: "OpenCode",
    programs: ["opencode"],
    model: "",
    reportsCost: false,
    restricted: false,
    // Its models are `provider/model`.
    argv: ({ program, prompt, model }) => [program, "run", ...modelFlag("-m", model), prompt],
  },
  // https://docs.openclaw.ai/cli/agent
  openclaw: {
    name: "OpenClaw",
    programs: ["openclaw"],
    model: "",
    reportsCost: false,
    restricted: false,
    // `exec` runs one turn without the Gateway, final text on stdout.
    argv: ({ program, prompt, model }) => [program, "agent", "exec", prompt, ...modelFlag("--model", model)],
  },
  // https://hermes-agent.nousresearch.com/docs/reference/cli-commands
  hermes: {
    name: "Hermes",
    programs: ["hermes"],
    model: "",
    reportsCost: false,
    restricted: false,
    // -Q answers once and prints only the answer; --yolo, as no one is there to approve a command.
    argv: ({ program, prompt, model }) => [program, "chat", "-q", prompt, "-Q", "--yolo", ...modelFlag("-m", model)],
  },
  // https://docs.x.ai/build/cli/headless-scripting
  grok: {
    name: "Grok",
    programs: ["grok"],
    model: "",
    reportsCost: false,
    restricted: false,
    // xAI's Grok Build and superagent's grok-cli both install `grok`; these are the flags both take.
    argv: ({ program, prompt, model }) => [program, "-p", prompt, ...modelFlag("-m", model)],
  },
  // https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html
  kimi: {
    name: "Kimi CLI",
    programs: ["kimi"],
    model: "",
    reportsCost: false,
    restricted: false,
    // --quiet is print mode with the final message only; print mode approves every tool.
    argv: ({ program, prompt, model }) => [program, "--quiet", "-p", prompt, ...modelFlag("-m", model)],
  },
} as const satisfies Record<string, HarnessKind>

export type Harness = keyof typeof AGENT_HARNESSES
/** Every agent a schedule may start, as `schedule agent <harness>` and a digest's agent take it. */
export const HARNESSES = Object.keys(AGENT_HARNESSES) as readonly Harness[]
export const AGENT_MODELS = Object.fromEntries(HARNESSES.map((id) => [id, AGENT_HARNESSES[id].model])) as Record<
  Harness,
  string
>

export const harnessOf = (id: Harness): HarnessKind => AGENT_HARNESSES[id]
export const COSTED = HARNESSES.filter((id) => harnessOf(id).reportsCost).join(", ")

export const isHarness = (id: string): id is Harness => (HARNESSES as readonly string[]).includes(id)

/** An agent's name, programs and what holds it, as `schedule agents list` answers them. */
export const harnessInfo = (harness: Harness) => {
  const { name, programs, reportsCost, restricted } = harnessOf(harness)
  return { id: harness, name, programs: [...programs], reportsCost, restricted }
}

/** Whether the harness reports what a run cost; the cost caps hold only for one that does. */
export const reportsCost = (harness: Harness): boolean => harnessOf(harness).reportsCost

/** The harness's program on PATH, by the first of its names found. */
export const programOf = (harness: Harness, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  harnessOf(harness)
    .programs.map((name) => findProgram(name, env, platform))
    .find(Boolean)

/** Which harness an agent schedule's argv starts, by its program's name; null for one no harness here knows. */
export const harnessOfArgv = (argv: readonly string[]): Harness | null => {
  const name = basename(argv[0] ?? "")
    .replace(/\.(exe|cmd)$/i, "")
    .toLowerCase()
  return HARNESSES.find((id) => (harnessOf(id).programs as readonly string[]).includes(name)) ?? null
}

/** Each harness, with its program when it is on PATH: what `schedule agents list` answers. */
export const harnessesOn = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  HARNESSES.map((id) => {
    const path = programOf(id, env, platform) ?? null
    return { ...harnessInfo(id), installed: path !== null, path }
  })
