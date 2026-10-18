import { metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import type { Argument, Command } from "commander"
import { commandPathOf, outputOf } from "../command-contract.js"
import { commandAt } from "../steps.js"
import { short } from "./commands-text.js"

type Kind = "chat" | "message" | "person" | "task" | "meeting" | "folder" | "topic" | "note" | "document" | "model"

/** Argument names onto the kinds `domain/references.ts` names; a plural takes the same kind. */
const ARGUMENT_KINDS: Readonly<Record<string, Kind>> = {
  chat: "chat",
  chats: "chat",
  message: "message",
  messages: "message",
  post: "message",
  person: "person",
  people: "person",
  task: "task",
  meeting: "meeting",
  folder: "folder",
  folders: "folder",
  topic: "topic",
  note: "note",
  document: "document",
  model: "model",
}

/** What a command answers with, by its declared entity, onto the same kinds. */
const ENTITY_KINDS: Readonly<Record<string, Kind>> = {
  message: "message",
  message_link: "message",
  chat: "chat",
  contact: "person",
  member: "person",
  person: "person",
  task: "task",
  meeting: "meeting",
  meeting_details: "meeting",
  meeting_hit: "meeting",
  meeting_summary: "meeting",
  folder: "folder",
  topic: "topic",
  note: "note",
  document: "document",
  model: "model",
}

/** The group a kind lives in, whose commands come first among the ones that take it. */
const HOME: Readonly<Record<Kind, string>> = {
  chat: "chats",
  message: "messages",
  person: "contacts",
  task: "tasks",
  meeting: "meetings",
  folder: "folders",
  topic: "topics",
  note: "notes",
  document: "documents",
  model: "models",
}

const SAMPLES: Readonly<Record<string, string>> = {
  chat: "Team",
  message: "1234",
  post: "1234",
  person: "Anna",
  people: "Anna",
  task: "12",
  meeting: "123",
  folder: "Work",
  topic: "General",
  model: "default",
  query: '"invoice"',
  text: '"on my way"',
  title: '"Weekly sync"',
  name: "daily",
  id: "1",
  file: "./report.pdf",
  link: "https://example.com/join/abc",
  url: "https://example.com",
  since: "1d",
  duration: "1d",
  limit: "20",
}

const MAX_NEXT = 3

export interface NextChoice {
  /** Command paths shown first, in this order: `messages context`. */
  pin?: readonly string[]
  /** Command paths never shown, though their arguments take what this one returns. */
  drop?: readonly string[]
}

const choices = new WeakMap<Command, NextChoice>()

/** Overrides the "Next usually" a command's help derives from types. Kept off `annotate`, like its section. */
export const nextUsually = <T extends Command>(command: T, choice: NextChoice): T => {
  choices.set(command, choice)
  return command
}

const kindOfArgument = (argument: Argument): Kind | undefined => ARGUMENT_KINDS[argument.name()]

const leaves = (command: Command): Command[] =>
  command.commands
    .filter((child) => !(child as Command & { _hidden?: boolean })._hidden)
    .flatMap((child) => (child.commands.length === 0 ? [child] : leaves(child)))

const rootOf = (command: Command): Command => {
  let at = command
  while (at.parent) at = at.parent
  return at
}

const call = (command: Command): string =>
  [
    rootOf(command).name(),
    ...commandPathOf(command),
    ...command.registeredArguments.map((one) => (one.required ? `<${one.name()}>` : `[${one.name()}]`)),
  ].join(" ")

const returnsOf = (command: Command): string => {
  const output = metaOf(command).output
  const { item, coverage } = outputOf(command)
  if (!output || coverage !== "declared-entity")
    return short(command.summary() || command.description()) || "not declared"
  const required = (item.required as string[] | undefined) ?? []
  const fields = [
    ...required,
    ...Object.keys((item.properties as object | undefined) ?? {}).filter((name) => !required.includes(name)),
  ]
  const noun = (output.view ? `${output.entity} ${output.view}` : output.entity).replaceAll("_", " ")
  const more = fields.length > 8 ? `, and ${fields.length - 8} more` : ""
  const root = rootOf(command)
  const schema = commandAt(root, "commands schema")
    ? `; every field: ${root.name()} commands schema ${commandPathOf(command).join(" ")}`
    : ""
  return `${noun} — ${fields.slice(0, 8).join(", ")}${more}${schema}`
}

const nextOf = (command: Command): Command[] => {
  const root = rootOf(command)
  const choice = choices.get(command) ?? {}
  const drop = new Set(choice.drop ?? [])
  const pinned = (choice.pin ?? []).flatMap((path) => commandAt(root, path) ?? [])
  const output = metaOf(command).output
  const kind = output ? ENTITY_KINDS[output.entity] : undefined
  const all = leaves(root)
  const derived = kind
    ? all
        .filter((other) => other !== command && !pinned.includes(other))
        .filter((other) => other.registeredArguments.some((argument) => kindOfArgument(argument) === kind))
        .map((other, order) => ({ other, order }))
        .sort((a, b) => {
          const rank = (other: Command) => [
            Number(writes(metaOf(other).effects)),
            Number(!other.registeredArguments.some((one) => one.required && kindOfArgument(one) === kind)),
            Number(commandPathOf(other)[0] !== HOME[kind]),
            Number(other.parent !== command.parent),
          ]
          const [left, right] = [rank(a.other), rank(b.other)]
          return left.reduce((found, value, at) => found || value - (right[at] ?? 0), 0) || a.order - b.order
        })
        .map(({ other }) => other)
    : []
  return [...pinned, ...derived].filter((other) => !drop.has(commandPathOf(other).join(" "))).slice(0, MAX_NEXT)
}

const sample = (name: string): string => SAMPLES[name] ?? `<${name}>`

const generatedExample = (command: Command): string => {
  const { query } = metaOf(command)
  const words = command.registeredArguments.flatMap((argument) => {
    const name = argument.name()
    // A list's `[query...]` is its field filters, not text; a search's is the text.
    if (name === "query" && query) return []
    if (!argument.required && SAMPLES[name] === undefined) return []
    return [argument.argChoices?.[0] ?? sample(name)]
  })
  const options = command.options
    .filter((option) => option.mandatory)
    .flatMap((option) => {
      const flag = option.long ?? option.short ?? option.flags
      const placeholder = /[<[]([^>\]]+)[>\]]/.exec(option.flags)?.[1]
      if (!(option.required || option.optional)) return [flag]
      return [flag, option.argChoices?.[0] ?? sample(placeholder ?? option.attributeName())]
    })
  // No profile word, as on the first screen and in written examples: the Usage line already shows `<profile>`.
  return [rootOf(command).name(), ...commandPathOf(command), ...words, ...options].join(" ")
}

export interface CommandHelp {
  returns: string
  next: readonly string[]
  examples: readonly string[]
  /** `generated` until the definition has an example of its own; the examples report lists those. */
  origin: "written" | "generated"
}

/** Returns, Next usually and Example for one command, from its definition alone. */
export const commandHelp = (command: Command): CommandHelp => {
  const written = metaOf(command).examples ?? []
  return {
    returns: returnsOf(command),
    next: nextOf(command).map(call),
    examples: written.length > 0 ? written : [generatedExample(command)],
    origin: written.length > 0 ? "written" : "generated",
  }
}

const LABEL = 15

/** The lines `--help` prints after a command's options. */
export const commandHelpText = (command: Command): string => {
  const { returns, next, examples } = commandHelp(command)
  const rows = (label: string, values: readonly string[]) =>
    values.map((value, at) => `${(at === 0 ? label : "").padEnd(LABEL)}${value}`)
  return ["", ...rows("Returns:", [returns]), ...rows("Next usually:", next), ...rows("Example:", examples), ""].join(
    "\n",
  )
}

/** The same, as Markdown lines for `docs/commands.md`: hand it to cli-base's `commandsPage` per command. */
export const commandHelpMarkdown = (root: Command, path: readonly string[]): string[] => {
  const command = commandAt(root, path.join(" "))
  if (!command || command.commands.length > 0) return []
  const { returns, next, examples } = commandHelp(command)
  const code = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(", ")
  return [
    `**Returns:** ${returns}`,
    ...(next.length > 0 ? [`**Next usually:** ${code(next)}`] : []),
    `**Example:** ${code(examples)}`,
  ]
}

/** Puts Returns, Next usually and Example on every leaf command's `--help`, worked out when the help is shown. */
export const installCommandHelp = (program: Command): void => {
  for (const command of leaves(program)) command.addHelpText("after", () => commandHelpText(command))
}

/** Which leaf commands still show a generated example, so the important ones get a written one. Report only. */
export const exampleReport = (program: Command): { written: string[]; generated: string[]; text: string } => {
  const written: string[] = []
  const generated: string[] = []
  for (const command of leaves(program))
    (commandHelp(command).origin === "written" ? written : generated).push(commandPathOf(command).join(" "))
  const total = written.length + generated.length
  const text = [
    `${program.name()}: ${written.length} of ${total} commands have a written example; ${generated.length} show a generated one:`,
    ...generated.map((path) => `  ${program.name()} ${path}`),
    "",
  ].join("\n")
  return { written, generated, text }
}
