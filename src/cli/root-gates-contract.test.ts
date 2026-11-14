import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import type { StepDefinition } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { addCrmCommands } from "../crm/cli/index.js"
import { mailReadCommands, mailReviewSteps } from "../mail/cli/index.js"
import { type AgentTool, toolsFromCommands } from "../mcp/agent.js"
import { addMeetingCommands } from "../meetings/cli/index.js"
import { MEETING_STEPS } from "../meetings/index.js"
import { messenger, sharedCommands, sharedProgram } from "../testing/shared-program.js"
import { createProgram, type ProgramDefinition } from "./program.js"
import { STEPS } from "./steps.js"

const SRC = join(import.meta.dirname, "..")
const refuse = (): never => {
  throw new CliError("configuration_error", "this test describes commands and runs none")
}
const app = { command: "kit", appName: "kit-cli", envPrefix: "KIT", description: "synthetic", version: "1.0.0" }
const kit = (add: (root: Command) => void): ProgramDefinition => ({
  app,
  commands: () => {
    const root = new Command(app.command)
    add(root)
    return [...root.commands]
  },
})

/** cli-core's kits, each mounted as a CLI mounts it: one program each, since several of them mount `search`. */
const KITS: Record<string, ProgramDefinition> = {
  // With server search, as tg mounts it: `search messages --backend` is what the step `search.server` names.
  messenger: { ...sharedProgram, commands: () => sharedCommands({ ...messenger, serverSearch: true }) },
  crm: kit((root) =>
    addCrmCommands(root, {
      app,
      open: refuse,
      writes: { kinds: ["deal", "lead"], verbs: ["create", "update", "move", "close", "remove"], idempotent: false },
    }),
  ),
  meetings: kit((root) =>
    addMeetingCommands(root, {
      get store() {
        return refuse()
      },
      accountId: 0,
      write: refuse,
      inRun: refuse,
    }),
  ),
  mail: kit((root) => {
    for (const command of mailReadCommands({ app, read: refuse })) root.addCommand(command)
  }),
}

const toolsOf = (definition: ProgramDefinition): Map<string, AgentTool> =>
  new Map(toolsFromCommands(describeProgram(createProgram(definition))).map((tool) => [tool.path.join(" "), tool]))
const TOOLS = Object.fromEntries(Object.entries(KITS).map(([name, definition]) => [name, toolsOf(definition)]))
const fieldsOf = (tool: AgentTool | undefined) => Object.keys(tool?.input.entries ?? {})

const sources = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(path)
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })

// The root's own value is what each of these means, so a command that reads it declares no option of its own.
const ROOT_READS: Record<string, string> = {
  "cli/program.ts dryRun": "the root program itself",
  "cli/dry-run-guard.ts dryRun": "previews any command the root --dry-run names",
  "cli/entry.ts dryRun": "the root --dry-run preview",
  "cli/messenger/ask.ts yes": "the yes to an ask level; an agent's run goes ahead without it (NEED-773)",
  "cli/messenger/store-import-command.ts yes": "an agent's run is a yes (NEED-773); a person adds --yes",
  "cli/account-remove.ts yes": "account remove is no MCP tool: a person removes an account",
  "cli/messenger/conversations-command.ts yes":
    "consent to send chat text to a provider, as conversations build --analyze and embed ask it: a person's to give",
  "cli/messenger/store-maintenance-command.ts yes": "store reset is no MCP tool: a person empties the store",
  "cli/messenger/backfill-command.ts timeout": "the run's deadline; over MCP the 45 s cap holds",
  "cli/messenger/gaps-command.ts timeout": "the run's deadline; over MCP the 45 s cap holds",
  "calendar/cli/index.ts timeout": "the run's deadline; over MCP the 45 s cap holds",
  "crm/cli/index.ts timeout": "the run's deadline; over MCP the 45 s cap holds",
  "meetings/cli/management.ts dryRun": "the root --dry-run preview, which the meeting writes honour themselves",
}

const GATES = ["yes", "timeout", "dryRun"] as const
const READ =
  /(?:optsWithGlobals(?:<[^()]*?>)?|(?:parent|program|rootOf\([^)]*\))[?!]?\.opts(?:<[^()]*?>)?)\(\)(\.\w+)?/g

/**
 * Each root write gate a file reads through `optsWithGlobals` or the root's or a parent's `opts()`: in the call's type,
 * the property read off it, the names destructured from it, or the properties read later off the name it is kept in.
 */
const rootReads = (path: string): string[] => {
  const text = readFileSync(path, "utf8")
  const found = new Set<string>()
  for (const match of text.matchAll(READ)) {
    const at = match.index ?? 0
    const before = text.slice(text.lastIndexOf("\n", at) + 1, at)
    const kept = /(?:const|let)\s+(\w+)\s*=\s*[\w.]*$/.exec(before)?.[1]
    const destructured = /\{([^}]*)\}\s*=\s*[\w.]*$/.exec(before)?.[1] ?? ""
    const later = kept ? text.slice(at, at + 4000) : ""
    for (const gate of GATES)
      if (
        new RegExp(`\\b${gate}\\b`).test(`${match[0]} ${destructured}`) ||
        (kept && new RegExp(`\\b${kept}\\.${gate}\\b`).test(later))
      )
        found.add(`${relative(SRC, path)} ${gate}`)
  }
  return [...found]
}

describe("a root write gate and a command's own option", () => {
  it("**no command reads --yes, --timeout or --dry-run off the root unless the root's is what it means**", () => {
    const reads = sources(SRC).flatMap(rootReads).sort()
    // A command that acts on --yes declares it, or an MCP tool cannot pass it: declare the option on the command.
    expect(reads).toEqual(Object.keys(ROOT_READS).sort())
  })

  it.each([
    ["messenger", "tasks scan"],
    ["crm", "store apply"],
    ["meetings", "meetings repair"],
  ])("%s `%s` takes yes over MCP", (kitName, path) => {
    expect(fieldsOf(TOOLS[kitName]?.get(path))).toContain("yes")
  })

  it("**no MCP tool takes allow_dangerous** but schedule agent's: only the owner says yes to what cannot be undone", () => {
    const taking = Object.entries(TOOLS).flatMap(([kitName, tools]) =>
      [...tools.values()]
        .filter((tool) => fieldsOf(tool).includes("allow_dangerous"))
        .map((tool) => `${kitName}: ${tool.command}`),
    )
    // Its yes starts an agent its own limits cannot hold, and it grants authority, which an agent needs the owner for.
    expect(taking).toEqual(["messenger: schedule agent"])
  })
})

type CommandStep = Extract<StepDefinition, { kind: "command" }>
const named = (steps: readonly StepDefinition[]) =>
  steps.filter((step): step is CommandStep => step.kind === "command" && step.command !== "*")

// The MCP entry an agent's own client reads: a person pastes it into that client's config.
const AT_A_TERMINAL = new Set(["mcp.config", "bot.mcp-config"])

describe("a next step and the MCP tool it names", () => {
  // A step names its arguments for a tool call as much as for a command line, where a root option such as `--timeout`
  // would parse; the tool takes only the command's own.
  it("**every argument a step names is one its tool takes**", () => {
    const cases: [string, CommandStep][] = [
      ...named(STEPS).map((step): [string, CommandStep] => ["messenger", step]),
      ...named(MEETING_STEPS).map((step): [string, CommandStep] => ["meetings", step]),
      ...named(mailReviewSteps()).map((step): [string, CommandStep] => ["mail", step]),
    ]
    const wrong = cases.flatMap(([kitName, step]) => {
      const tool = TOOLS[kitName]?.get(step.command)
      if (!tool) return AT_A_TERMINAL.has(step.id) ? [] : [`${step.id}: ${step.command} is no MCP tool`]
      const fields = fieldsOf(tool)
      return step.args.filter((arg) => !fields.includes(arg.name)).map((arg) => `${step.id}: no ${arg.name}`)
    })
    expect(wrong).toEqual([])
  })
})
