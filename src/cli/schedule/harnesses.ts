import { basename, join } from "node:path"
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
  /** The schedule's own folder, the run's working folder, where `files` are written before each run. */
  folder: string
}

/** How a harness starts: its argv, the variables it reads its limits from, and files written into the run's folder. */
interface HarnessStart {
  argv: string[]
  environment?: Record<string, string>
  /** Paths relative to the schedule's folder, and what each holds. */
  files?: Record<string, string>
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
   * The harness itself holds the agent to the CLIs' commands, as its docs say its one-shot mode does, or to their
   * folders (codex's sandbox). One that is not would run any command, so no schedule starts it, as the owner ruled.
   */
  restricted: boolean
  /** Why it is not restricted: what its docs offer for a one-shot run, and why that does not hold it to the CLIs. */
  restrictedReason?: string
  start(run: HarnessRun): HarnessStart
}

const modelFlag = (flag: string, model: string) => (model ? [flag, model] : [])

/** A command that chains, pipes, substitutes or redirects: more than the one CLI command a prefix rule allows. */
const CHAINED = "[;&|`$<>\\n]"

/** One Gemini policy rule as TOML; every value is a string or a number. */
const rule = (fields: Record<string, string | number>) =>
  [
    "[[rule]]",
    ...Object.entries(fields).map(
      ([key, value]) => `${key} = ${typeof value === "number" ? value : JSON.stringify(value)}`,
    ),
    "",
  ].join("\n")

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
    start: ({ program, prompt, model, clis, leanStart, maxCost }) => ({
      argv: [
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
    }),
  },
  // https://learn.chatgpt.com/docs/non-interactive-mode
  codex: {
    name: "Codex",
    programs: ["codex"],
    // No alias of claude's tier, so codex's own default.
    model: "",
    reportsCost: false,
    restricted: true,
    start: ({ program, prompt, model, folders }) => ({
      argv: [
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
    }),
  },
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
  gemini: {
    name: "Gemini CLI",
    programs: ["gemini"],
    model: "",
    reportsCost: false,
    // https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md: a rule that would ask "is
    // treated as deny" in non-interactive mode, and write tools ask by default. A project's own policies do not apply,
    // so the system settings file names this policy.
    restricted: true,
    start: ({ program, prompt, model, clis, folder }) => ({
      argv: [program, "-p", prompt, ...modelFlag("-m", model)],
      environment: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(folder, "gemini", "settings.json") },
      files: {
        "gemini/settings.json": JSON.stringify({ policyPaths: [join(folder, "gemini", "policy.toml")] }),
        "gemini/policy.toml": [
          rule({ toolName: "run_shell_command", decision: "deny", priority: 10 }),
          ...clis.map((one) =>
            rule({ toolName: "run_shell_command", commandPrefix: `${one.command} `, decision: "allow", priority: 100 }),
          ),
          // How a prefix rule treats `memo x && rm …` is not documented; a chained or substituted command is refused.
          rule({ toolName: "run_shell_command", commandRegex: CHAINED, decision: "deny", priority: 200 }),
        ].join("\n"),
      },
    }),
  },
  // https://cursor.com/docs/cli/headless
  cursor: {
    name: "Cursor",
    // `cursor` alone starts the editor; the agent's own program was `cursor-agent` and is now `agent`.
    programs: ["cursor-agent", "agent"],
    model: "",
    reportsCost: false,
    // https://cursor.com/docs/cli/reference/permissions: without --force "anything that would need approval is
    // rejected"; print mode writes files even so, and a deny wins over an allow.
    restricted: true,
    start: ({ program, prompt, model, clis }) => ({
      argv: [program, "-p", prompt, "--output-format", "text", ...modelFlag("--model", model)],
      files: {
        ".cursor/cli.json": JSON.stringify({
          permissions: { allow: [...clis.map((one) => `Shell(${one.command})`), "Read(**)"], deny: ["Write(**)"] },
        }),
      },
    }),
  },
  // https://opencode.ai/docs/cli
  opencode: {
    name: "OpenCode",
    programs: ["opencode"],
    model: "",
    reportsCost: false,
    // https://opencode.ai/docs/permissions/: "configured deny rules always remain enforced", the last matching rule
    // wins, and a rule applies to every part of a chained command. Never --auto. The variable, as a project file is
    // looked for from the working folder up to the root.
    restricted: true,
    start: ({ program, prompt, model, clis }) => ({
      // Its models are `provider/model`.
      argv: [program, "run", ...modelFlag("-m", model), prompt],
      environment: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "deny" },
            ...clis.map((one) => ({ action: "shell", resource: `${one.command} *`, effect: "allow" })),
            { action: "edit", resource: "*", effect: "deny" },
          ],
        }),
      },
    }),
  },
  // https://docs.openclaw.ai/cli/agent
  openclaw: {
    name: "OpenClaw",
    programs: ["openclaw"],
    model: "",
    reportsCost: false,
    restricted: false,
    restrictedReason:
      "its command allow-list (https://docs.openclaw.ai/tools/exec-approvals.md) lives in its own state database, and " +
      "its docs do not say it holds for a one-shot `agent exec` run",
    start: ({ program, prompt, model }) => ({
      argv: [program, "agent", "exec", prompt, ...modelFlag("--model", model)],
    }),
  },
  // https://hermes-agent.nousresearch.com/docs/reference/cli-commands
  hermes: {
    name: "Hermes",
    programs: ["hermes"],
    model: "",
    reportsCost: false,
    restricted: false,
    restrictedReason:
      "it checks only commands on its list of dangerous patterns and runs any other " +
      "(https://hermes-agent.nousresearch.com/docs/user-guide/security/); it has no allow-list",
    start: ({ program, prompt, model }) => ({ argv: [program, "chat", "-q", prompt, "-Q", ...modelFlag("-m", model)] }),
  },
  // https://docs.x.ai/build/cli/headless-scripting
  grok: {
    name: "Grok",
    programs: ["grok"],
    model: "",
    reportsCost: false,
    // https://docs.x.ai/build/features/permissions: dontAsk "silently denies anything without an explicit allow rule",
    // for headless runs. superagent's grok-cli, which installs `grok` too, has no such flags and refuses the run.
    restricted: true,
    start: ({ program, prompt, model, clis }) => ({
      argv: [
        program,
        "-p",
        prompt,
        "--permission-mode",
        "dontAsk",
        ...clis.flatMap((one) => ["--allow", `Bash(${one.command} *)`]),
        "--allow",
        "Read",
        "--allow",
        "Grep",
        ...modelFlag("-m", model),
      ],
    }),
  },
  // https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html
  kimi: {
    name: "Kimi CLI",
    programs: ["kimi"],
    model: "",
    reportsCost: false,
    restricted: false,
    restrictedReason:
      "print mode approves every tool call and has no allow-list " +
      "(https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html); its docs do not say a hook runs there",
    start: ({ program, prompt, model }) => ({ argv: [program, "--quiet", "-p", prompt, ...modelFlag("-m", model)] }),
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
  const { name, programs, reportsCost, restricted, restrictedReason } = harnessOf(harness)
  return {
    id: harness,
    name,
    programs: [...programs],
    reportsCost,
    restricted,
    restrictedReason: restrictedReason ?? null,
  }
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
