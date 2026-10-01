import { EXIT_CODES } from "../exit-codes.js"
import type { ArgumentInfo, CommandInfo, OptionInfo } from "./index.js"

/** The labels of the tables; the same for every CLI writing in one language. */
export type CommandsPageLabels = {
  option: string
  does: string
  argument: string
  isWhat: string
  required: string
  optional: string
  /** Precedes a default: `Default` → "… Default: `20`." */
  defaultIs: string
  /** Precedes the allowed values: `One of` → "… One of: `new`, `old`." */
  oneOf: string
  code: string
  when: string
  success: string
  otherwise: string
}

export const COMMANDS_PAGE_LABELS = {
  en: {
    option: "Option",
    does: "What it does",
    argument: "Argument",
    isWhat: "What it is",
    required: "required",
    optional: "optional",
    defaultIs: "Default",
    oneOf: "One of",
    code: "Code",
    when: "When",
    success: "it worked",
    otherwise: "anything else",
  },
  ru: {
    option: "Опция",
    does: "Что делает",
    argument: "Аргумент",
    isWhat: "Что это",
    required: "обязательный",
    optional: "необязательный",
    defaultIs: "По умолчанию",
    oneOf: "Одно из",
    code: "Код",
    when: "Когда",
    success: "получилось",
    otherwise: "всё остальное",
  },
} as const satisfies Record<string, CommandsPageLabels>

/** The CLI's own words: everything on the page that is not read out of the program. */
export type CommandsPageText = {
  /** The first line, an HTML comment saying the page is generated and by what. */
  banner: string
  title: string
  /** Markdown between the title and the global options. */
  intro: string
  globalHeading: string
  globalIntro: string
  /** Shown under a command that changes something outside this machine. */
  mutates: string
  /** Shown instead under a command marked `local`, which changes only this machine; without it, nothing is. */
  mutatesLocal?: string
  exitHeading: string
  exitIntro: string
  /** Markdown after the exit codes; may be empty. */
  outro: string
}

export type CommandsPage = {
  cli: string
  commands: readonly CommandInfo[]
  options: readonly OptionInfo[]
  labels: CommandsPageLabels
  text: CommandsPageText
}

/** A cell that will not break the table it sits in; `~~struck~~` in a description would strike the row. */
const cell = (text: string | undefined): string =>
  (text ?? "").replace(/\|/g, "\\|").replace(/~/g, "\\~").replace(/\n+/g, " ").trim()

const sentence = (text: string | undefined): string => {
  const said = cell(text)
  return said === "" || /[.!?]$/.test(said) ? said : `${said}.`
}

/**
 * The whole `docs/commands.md`: every command at any depth, every option and argument, the exit
 * codes. Descriptions are quoted as `--help` prints them, untranslated — a translation here would
 * give the sentence a second home, and the one on screen is the one that gets corrected.
 */
export const commandsPage = ({ cli, commands, options, labels, text }: CommandsPage): string => {
  // What a value may be and what it is when left out: Commander keeps both out of the description.
  const extras = ({ choices, default: fallback }: { choices?: readonly string[]; default?: unknown }) =>
    [
      choices ? ` ${labels.oneOf}: ${choices.map((choice) => `\`${choice}\``).join(", ")}.` : "",
      fallback === undefined || fallback === false ? "" : ` ${labels.defaultIs}: \`${String(fallback)}\`.`,
    ].join("")

  // The flags go through `cell` too: `--order <recent|name>` would otherwise split the row.
  const optionRows = (list: readonly OptionInfo[]) =>
    list.map((option) => `| \`${cell(option.flags)}\` | ${sentence(option.description)}${extras(option)} |`).join("\n")

  const argumentRows = (list: readonly ArgumentInfo[]) =>
    list
      .map(
        (argument) =>
          `| \`${cell(argument.name)}\` | ${argument.required ? labels.required : labels.optional} | ${sentence(argument.description)}${extras(argument)} |`,
      )
      .join("\n")

  const body = (command: CommandInfo): string[] => {
    const parts = [cell(command.description), ""]
    const label = command.mutates ? (command.local ? text.mutatesLocal : text.mutates) : undefined
    if (label) parts.push(label, "")
    parts.push("```sh", command.usage, "```")
    if (command.arguments.length > 0)
      parts.push("", `| ${labels.argument} | | ${labels.isWhat} |`, "|---|---|---|", argumentRows(command.arguments))
    if (command.options.length > 0)
      parts.push("", `| ${labels.option} | ${labels.does} |`, "|---|---|", optionRows(command.options))
    return parts
  }

  // A group shows its own usage only when it takes options of its own, as `doctor --online` does.
  const section = (command: CommandInfo, depth: number): string => {
    const heading = `${"#".repeat(Math.min(depth, 4))} \`${cli} ${command.path.join(" ")}\``
    if (command.commands.length === 0) return [heading, "", ...body(command)].join("\n")
    const own = command.options.length > 0 ? body(command) : [cell(command.description)]
    return [heading, "", ...own, "", command.commands.map((child) => section(child, depth + 1)).join("\n\n")]
      .join("\n")
      .trimEnd()
  }

  const exitCodes = [
    `| ${labels.code} | ${labels.when} |`,
    "|---|---|",
    `| \`0\` | ${labels.success} |`,
    ...Object.entries(EXIT_CODES).map(([name, code]) => `| \`${code}\` | \`${name}\` |`),
    `| \`1\` | ${labels.otherwise} |`,
  ].join("\n")

  return [
    text.banner,
    `# ${text.title}`,
    text.intro,
    `## ${text.globalHeading}`,
    text.globalIntro,
    [`| ${labels.option} | ${labels.does} |`, "|---|---|", optionRows(options)].join("\n"),
    commands.map((command) => section(command, 2)).join("\n\n"),
    `## ${text.exitHeading}`,
    text.exitIntro,
    exitCodes,
    text.outro,
  ]
    .filter((part) => part !== "")
    .join("\n\n")
    .concat("\n")
}
