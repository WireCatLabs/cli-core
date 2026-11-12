import { basename } from "node:path"
import { type AgentCli, findProgram, WORK_FOLDER } from "../../background/schedules.js"

/**
 * Claude starts without the owner's MCP servers, skills and slash commands: a run reads its instructions through the
 * CLI, and the rest was most of its starting context. `--permission-mode` and `--allowedTools` hold either way.
 */
const LEAN_CLAUDE = ["--tools", "Bash", "--strict-mcp-config", "--disable-slash-commands"]

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

/**
 * How a harness starts: its argv, the variables it reads its limits from, and files written into the run's own empty
 * work folder before each run. `WORK_FOLDER` in a variable or a file stands for that folder.
 */
interface HarnessStart {
  argv: string[]
  environment?: Record<string, string>
  /** Paths relative to the work folder, and what each holds. */
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
   * Its own docs show a one-shot run held to the CLIs' commands, every other command denied without a prompt. One that
   * is not would run any command, so no schedule starts it, as the owner ruled.
   */
  restricted: boolean
  /** Why it is not restricted: what its docs offer for a one-shot run, and why that does not hold it to the CLIs. */
  restrictedReason?: string
  /**
   * Not restricted, yet a schedule may start it once the owner accepts that with `--allow-dangerous`: its sandbox blocks
   * writes outside a few folders and the network, though it may run any program.
   */
  allowedWithAck?: boolean
  start(run: HarnessRun): HarnessStart
}

const modelFlag = (flag: string, model: string) => (model ? [flag, model] : [])

/**
 * Gemini tests a rule's regex against the call's arguments as JSON, after `"command":"`, so a pattern starts at the
 * command's first character and `^` never matches. This one denies a command that chains, pipes, substitutes or runs
 * in the background anywhere in its quoted text, a newline being `\n` there: more than the one CLI command a prefix
 * rule allows. `<` and `>` stay allowed, as queries such as `date>1d` use them.
 */
const CHAINED = '(?:[^"\\\\]|\\\\.)*?(?:[;&|`$]|\\\\n)'
/** A command that starts by setting variables (`MEMO_READ_ONLY=0 memo …`, `env -u …`): never a plain CLI command. */
const ENV_PREFIX = "\\s*(?:env\\s|[A-Za-z_][A-Za-z0-9_]*=)"

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
 * documents a one-shot mode that answers on stdout and exits are here; GLM has no agent CLI of its own, Z.ai runs it
 * inside these agents.
 */
const AGENT_HARNESSES = {
  // https://code.claude.com/docs/en/headless
  claude: {
    name: "Claude Code",
    programs: ["claude"],
    // A mid-tier model by default.
    model: "sonnet",
    reportsCost: true,
    // https://code.claude.com/docs/en/iam: dontAsk denies every tool its allow rules do not name.
    restricted: true,
    start: ({ program, prompt, model, clis, leanStart, maxCost }) => ({
      argv: [
        program,
        "-p",
        prompt,
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        ...clis.map((one) => `Bash(${one.command}:*)`),
        "--no-session-persistence",
        // The owner's own settings may allow other commands (python, node); none of them is read, lean or not.
        "--setting-sources",
        "",
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
    model: "",
    reportsCost: false,
    restricted: false,
    allowedWithAck: true,
    restrictedReason:
      "it may run any program, and its rules (https://learn.chatgpt.com/docs/agent-configuration/rules) cannot deny " +
      "every command but the CLIs'. Its sandbox (https://learn.chatgpt.com/docs/sandboxing) blocks the network and " +
      "every write outside its run's folder, the message store's folder and the CLIs' state and cache folders. The " +
      "store must stay writable, as SQLite cannot read it otherwise, so a program such as sqlite3 can change or " +
      "delete the store and the read-only lock does not stop it; it reads every file the owner can",
    // --ignore-user-config and --ignore-rules keep the owner's ~/.codex config and rules from widening the sandbox.
    start: ({ program, prompt, model, folders }) => ({
      argv: [
        program,
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "--cd",
        WORK_FOLDER,
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
    // treated as deny" in non-interactive mode. The policy is an admin one, the top tier, so no user setting or rule
    // outranks it; the system settings also drop the owner's allowed tools and MCP servers and turn yolo off.
    restricted: true,
    start: ({ program, prompt, model, clis }) => ({
      argv: [program, "-p", prompt, ...modelFlag("-m", model)],
      environment: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: `${WORK_FOLDER}/gemini/settings.json` },
      files: {
        "gemini/settings.json": JSON.stringify({
          adminPolicyPaths: [`${WORK_FOLDER}/gemini/policy.toml`],
          tools: { allowed: [], core: ["run_shell_command"] },
          mcpServers: {},
          security: { disableYoloMode: true },
          general: { defaultApprovalMode: "default" },
        }),
        "gemini/policy.toml": [
          // The system settings' empty mcpServers is merged into the owner's, so their servers' tools are denied here.
          rule({ toolName: "*", decision: "deny", priority: 1 }),
          rule({ toolName: "run_shell_command", decision: "deny", priority: 10 }),
          ...clis.map((one) =>
            rule({ toolName: "run_shell_command", commandPrefix: `${one.command} `, decision: "allow", priority: 100 }),
          ),
          // How a prefix rule treats `memo x && rm …` is not documented; a chained or substituted command is refused.
          rule({ toolName: "run_shell_command", commandRegex: CHAINED, decision: "deny", priority: 200 }),
          rule({ toolName: "run_shell_command", commandRegex: ENV_PREFIX, decision: "deny", priority: 200 }),
          ...["write_file", "replace", "web_fetch", "google_web_search"].map((toolName) =>
            rule({ toolName, decision: "deny", priority: 200 }),
          ),
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
    restricted: false,
    restrictedReason:
      "its Shell(<command>) rule matches the first word only, and its docs (https://cursor.com/docs/cli/reference/permissions) " +
      "do not say a chained command such as `memo x; other` is denied",
    start: ({ program, prompt, model }) => ({
      argv: [program, "-p", prompt, "--output-format", "text", ...modelFlag("--model", model)],
    }),
  },
  // https://opencode.ai/docs/cli
  opencode: {
    name: "OpenCode",
    programs: ["opencode"],
    model: "",
    reportsCost: false,
    // https://opencode.ai/docs/permissions/: "configured deny rules always remain enforced", the last matching rule
    // wins, and a rule applies to every part of a chained command. Everything is denied but the CLIs' commands; the
    // older `permission` form is given too, so a version that reads only it is held as well. Never --auto.
    restricted: true,
    start: ({ program, prompt, model, clis }) => ({
      // Its models are `provider/model`.
      argv: [program, "run", ...modelFlag("-m", model), prompt],
      environment: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...clis.map((one) => ({ action: "shell", resource: `${one.command} *`, effect: "allow" })),
          ],
          permission: {
            "*": "deny",
            edit: "deny",
            webfetch: "deny",
            bash: { "*": "deny", ...Object.fromEntries(clis.map((one) => [`${one.command} *`, "allow"])) },
          },
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
    start: ({ program, prompt, model }) => ({
      argv: [program, "chat", "-q", prompt, "-Q", ...modelFlag("-m", model)],
    }),
  },
  // https://docs.x.ai/build/cli/headless-scripting
  grok: {
    name: "Grok",
    programs: ["grok"],
    model: "",
    reportsCost: false,
    restricted: false,
    restrictedReason:
      "its dontAsk mode denies what no --allow rule names (https://docs.x.ai/build/features/permissions), but its docs " +
      "do not say a chained command such as `memo x; other` is denied; superagent's grok-cli, also `grok`, has no rules",
    start: ({ program, prompt, model, clis }) => ({
      argv: [
        program,
        "-p",
        prompt,
        "--permission-mode",
        "dontAsk",
        ...clis.flatMap((one) => ["--allow", `Bash(${one.command} *)`]),
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

/** The variables a harness reads its limits from; a run rebuilds them, so a saved one is never taken from the file. */
export const HARNESS_VARIABLES = ["GEMINI_CLI_SYSTEM_SETTINGS_PATH", "OPENCODE_CONFIG_CONTENT"] as const
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
  const { name, programs, reportsCost, restricted, restrictedReason, allowedWithAck } = harnessOf(harness)
  return {
    id: harness,
    name,
    programs: [...programs],
    reportsCost,
    restricted,
    restrictedReason: restrictedReason ?? null,
    allowedWithAck: allowedWithAck === true,
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

/**
 * Why no schedule may start the harness, or nothing: one held to the CLIs' commands may run, and one the owner
 * accepted with `--allow-dangerous` where its sandbox allows that.
 */
export const harnessRefusal = (harness: Harness, accepted: boolean): string | undefined => {
  const kind = harnessOf(harness)
  if (kind.restricted) return undefined
  if (kind.allowedWithAck === true)
    return accepted ? undefined : `${kind.name} runs only with --allow-dangerous, as ${kind.restrictedReason}`
  return `${kind.name} cannot run on a schedule: ${kind.restrictedReason}`
}

/** Each harness, with its program when it is on PATH: what `schedule agents list` answers. */
export const harnessesOn = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  HARNESSES.map((id) => {
    const path = programOf(id, env, platform) ?? null
    return { ...harnessInfo(id), installed: path !== null, path }
  })
