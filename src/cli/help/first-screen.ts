import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Help, Option } from "commander"
import wrapAnsi from "wrap-ansi"
import { NO_EFFECTS } from "../effects.js"
import { commandAt } from "../steps.js"
import { EXAMPLE_PROFILE, installCommandHelp } from "./command-help.js"

export interface FirstScreenLine {
  /** The command without the tool's name or the profile: `review --since 1d`. */
  command: string
  does: string
}

/** What a tool says on its first screen; the rest of the screen is the same for every WireCat tool. */
export interface FirstScreen {
  /** One sentence after `tg —`. Unset, the program's description. */
  pitch?: string
  /** 6–8 lines, the ones a plain API client would not give. Unset, the block is left out. */
  can?: readonly FirstScreenLine[]
  /** `false` for a tool whose commands take no leading profile: no profile sentence, no `<profile>` in the usage. */
  profile?: boolean
  /** The first command to run. Unset, `<tool> personal setup` when the tool has `setup`. */
  start?: string
}

interface Tool {
  command: string
  /** The npm package `setup` installs it from. */
  package: string
  shown?: string
  does: string
}

/** Every WireCat tool, as "Works with" names it; a tool's own entry is left out of its screen. */
export const WIRECAT_TOOLS: readonly Tool[] = [
  {
    command: "tg",
    package: "@wirecat/tg-cli",
    does: "Telegram in the same local store: search, review and tasks offline",
  },
  {
    command: "max",
    package: "@wirecat/max-cli",
    does: "MAX in the same local store: search, review and tasks offline",
  },
  {
    command: "wa",
    package: "@wirecat/whatsapp-cli",
    does: "WhatsApp in the same local store: search, review and tasks offline",
  },
  {
    command: "zm",
    package: "@wirecat/zoom-cli",
    does: "Zoom meetings: transcripts and summaries, searchable with your other WireCat data",
  },
  {
    command: "drive",
    package: "@wirecat/drive-cli",
    does: "Google Drive and Docs as local text, searchable with your other WireCat data",
  },
  {
    command: "memo",
    package: "@wirecat/cli-memo",
    shown: "memo context <person>",
    does: "one person across messengers, mail, notes and meetings",
  },
  {
    command: "mail",
    package: "@wirecat/mail-cli",
    does: "IMAP mail in the same local store: search your mailbox offline, next to your other WireCat data",
  },
]

const WIDTH = 100

const widest = (texts: readonly string[]) => texts.reduce((most, text) => Math.max(most, text.length), 0)

const block = (title: string, rows: readonly (readonly [string, string])[], column: number): string[] =>
  rows.length === 0 ? [] : ["", `${title}:`, ...rows.map(([left, right]) => `  ${left.padEnd(column)}${right}`)]

type Row = readonly [label: string, command: string, does: string]

const TOPICS: readonly (readonly [long: string, topic: string])[] = [
  ["--json", "output"],
  ["--offline", "offline"],
  ["--timeout", "timeouts"],
  ["--dry-run", "dry run"],
]

/** Only the topics this program has options for: memo has no --offline. */
const optionTopics = (program: Command): string => {
  const longs = new Set(program.options.map((option) => option.long))
  const topics = TOPICS.filter(([long]) => longs.has(long)).map(([, topic]) => topic)
  return topics.length > 0 ? topics.join(", ") : "the options every command takes"
}

/** Only commands the tool has: `guide` and `setup` are not in every tool. */
const pointers = (program: Command, cli: string, start: string | undefined, profile: boolean): string[] => {
  const has = (path: string) => commandAt(program, path) !== undefined
  const next = [
    has("commands") ? [`${cli} commands`, "every command, by section"] : undefined,
    has("guide") ? [`${cli} guide`, "scenarios: command sequences for common tasks"] : undefined,
    [`${cli} help options`, optionTopics(program)],
  ].filter((row) => row !== undefined)
  const rows: Row[] = [
    ...(start ? [["Start here:", start, profile ? "(any profile name works)" : ""] as const] : []),
    ...(has("account list")
      ? [["", `${cli} account list`, "your profiles and their logged-in accounts"] as const]
      : []),
    ...next.map(([command = "", does = ""], at) => [at === 0 ? "Next:" : "", command, does] as const),
    ...(has("skill show") ? [["For agents:", `${cli} skill show`, "rules and the discovery loop"] as const] : []),
  ]
  const width = widest(rows.map(([, command]) => command)) + 2
  return ["", ...rows.map(([label, command, does]) => `${label.padEnd(14)}${command.padEnd(width)}${does}`.trimEnd())]
}

/**
 * The screen `<tool> --help` and a bare `<tool>` show: what the tool is for, what it does that a client would not,
 * the other tools, and where the full list, the scenarios and the options are. It never lists every command.
 */
export const firstScreen = (program: Command, screen: FirstScreen = {}): string => {
  const cli = program.name()
  const profile = screen.profile !== false
  const pitch = screen.pitch ?? program.description().split("\n")[0] ?? ""
  const can = (screen.can ?? []).map(({ command, does }) => [command, does] as const)
  const works = WIRECAT_TOOLS.filter((tool) => tool.command !== cli).map(
    ({ command, shown, does }) => [shown ?? command, does] as const,
  )
  const column = Math.max(22, widest([...can, ...works].map(([left]) => left))) + 2
  const start = screen.start ?? (commandAt(program, "setup") ? `${cli} ${EXAMPLE_PROFILE} setup` : undefined)
  return [
    wrapAnsi(`${cli} — ${pitch}`, WIDTH),
    "",
    `Usage: ${cli} ${profile ? "<profile> " : ""}<command> [options]`,
    ...(profile ? ["Account commands start with your profile, a name you choose; none is ever assumed."] : []),
    ...block("What you can do", can, column),
    ...block("Works with", works, column),
    ...pointers(program, cli, start, profile),
    "",
  ].join("\n")
}

const optionsScreen = (program: Command): string => {
  const helper = program.createHelp()
  const width = helper.longestOptionTermLength(program, helper)
  return [
    `Options for every ${program.name()} command:`,
    ...helper
      .visibleOptions(program)
      .map((option) => helper.formatItem(helper.optionTerm(option), width, helper.optionDescription(option), helper)),
    "",
  ].join("\n")
}

/**
 * Puts the first screen on `--help`, a bare run and `help`, and Returns, Next usually and Example on every leaf
 * command's `--help`. `help options` prints the options for every command, `--help-all` the full commander help;
 * both are hidden, so `commands --json` and MCP do not change. For a tool that builds its own program;
 * `createProgram` calls it for tg, max and wa.
 */
export const installHelp = (program: Command, screen: FirstScreen = {}): Command => {
  let full = false
  const own = program.configureHelp()
  program.configureHelp({
    ...own,
    // Commander copies this configuration to children made with `.command()`, so only the root gets the screen.
    formatHelp: (command, helper) =>
      command === program && !full
        ? firstScreen(program, screen)
        : (own.formatHelp ?? Help.prototype.formatHelp).call(helper, command, helper),
  })
  installCommandHelp(program, { profile: screen.profile !== false })
  program.addOption(new Option("--help-all", "the full help: every command and option").hideHelp())
  program.on("option:help-all", () => {
    full = true
    program.help()
  })
  if (program.commands.some((command) => command.name() === "help")) return program
  const help = annotate(new Command("help"), { effects: NO_EFFECTS, mcp: false })
    .description("this screen; help options: the options for every command; help <command>: that command's help")
    .argument("[topic...]", "options, or a command path")
    .action((topic: string[]) => {
      if (topic.length === 0) return program.outputHelp()
      if (topic.length === 1 && topic[0] === "options")
        return program.configureOutput().writeOut?.(optionsScreen(program))
      const command = commandAt(program, topic.join(" "))
      if (!command)
        throw new CliError(
          "validation_error",
          `no command "${topic.join(" ")}" — run \`${program.name()} help\`, or \`${program.name()} help options\``,
          { available: program.commands.map((one) => one.name()).filter((name) => name !== "help") },
        )
      command.outputHelp()
    })
  program.addCommand(help, { hidden: true })
  return program
}
