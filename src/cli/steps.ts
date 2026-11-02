import {
  STEPS as BASE_STEPS,
  defineSteps,
  MAX_NEXT_STEPS,
  type NextStep,
  type StepInput,
  stepOf,
  writes,
} from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { IMAGE_MODELS } from "../images/picture/models.js"
import { typedCommand } from "../runs/scope.js"
import { judgedTargets } from "./effects.js"

/**
 * Every step an answer or an error may name. A step's command must exist in tg and max alike, and its
 * arguments must parse against that command (`steps.test.ts`).
 */
export const STEPS = defineSteps([
  ...BASE_STEPS,
  {
    id: "messages.sync",
    command: "messages sync",
    args: [
      { name: "chat", required: false },
      { name: "all", required: false },
      { name: "since_time", required: false },
      { name: "background", required: false },
      { name: "include", required: false },
    ],
    why: "the local copy is missing messages; syncing brings them in",
  },
  {
    id: "messages.transcribe",
    command: "messages transcribe",
    args: [
      { name: "chat", required: true },
      { name: "message", required: true },
    ],
    why: "a voice message is not heard yet; this hears it",
  },
  {
    id: "messages.scheduled",
    command: "messages scheduled",
    args: [{ name: "chat", required: true }],
    why: "it is waiting to be sent and gets a new id then; this lists what is still waiting",
  },
  {
    id: "messages.download",
    command: "messages download",
    args: [
      { name: "chat", required: true },
      { name: "all", required: false },
      { name: "output_dir", required: false },
    ],
    why: "it stopped before the whole chat; running it again goes on where it stopped",
  },
  {
    id: "messages.list",
    command: "messages list",
    args: [{ name: "chat", required: true }],
    why: "only the newest were read here; this reads the chat itself",
  },
  {
    id: "inbox.all",
    command: "inbox",
    args: [{ name: "all", required: true }],
    why: "muted and archived chats were left out; --all reads them too",
  },
  {
    id: "review.all",
    command: "review",
    args: [{ name: "all", required: true }],
    why: "muted and archived chats were left out; --all reads them too",
  },
  {
    id: "review.next",
    command: "review",
    args: [{ name: "query", required: true }],
    why: "the next review starts where this one ended",
  },
  {
    id: "chats.members",
    command: "chats members list",
    args: [{ name: "chat", required: true }],
    why: "the chat's member list has everyone it lets you see",
  },
  {
    id: "chats.members-fetch",
    command: "chats members fetch",
    args: [
      { name: "chat", required: true },
      { name: "track", required: false },
    ],
    why: "nothing is recorded yet; a fetch records the members, and --track keeps doing it daily",
  },
  {
    id: "models.download",
    command: "models download",
    args: [{ name: "model", required: true }],
    why: "{model} is not downloaded, so nothing is searched by meaning",
  },
  {
    id: "models.download-image",
    command: "images models download",
    args: [{ name: "model", required: true }],
    why: "{model} is not downloaded, so pictures are not searched by what they show",
  },
  {
    id: "store.migrate",
    command: "store migrate",
    args: [],
    why: "a search index is still being built; this finishes it",
  },
  {
    id: "attachments.extract",
    command: "attachments extract",
    args: [
      { name: "cursor", required: true },
      { name: "chat", required: false },
    ],
    why: "it stopped before every file was read; this goes on where it stopped",
  },
  {
    id: "store.job",
    command: "store jobs show",
    args: [{ name: "job", required: false }],
    why: "it runs in the background; this shows how far it got",
  },
  {
    id: "store.reindex",
    command: "store rebuild",
    args: [],
    why: "the stems were built by another stemmer; this builds them again",
  },
  {
    id: "mentions.rebuild",
    command: "mentions rebuild",
    args: [{ name: "kind", required: false }],
    why: "phone numbers already found were read by the old phone_countries; this reads them again",
  },
  {
    id: "mentions.review",
    command: "mentions list",
    args: [{ name: "new", required: true }],
    why: "{shown} mentions found since the last review wait to be confirmed or rejected",
  },
  {
    id: "conversations.build",
    command: "conversations links rebuild",
    args: [{ name: "chat", required: false }],
    why: "conversations are missing or older than the messages; this builds them",
  },
  {
    id: "conversations.embed",
    command: "conversations embed",
    args: [{ name: "chat", required: true }],
    why: "the chat's conversations are not searchable by meaning yet; this embeds them",
  },
  {
    id: "conversations.rebuild",
    command: "conversations rebuild",
    args: [],
    why: "messages have no vectors yet, so discovery searched by words alone; this embeds them, a bounded batch a run",
  },
  {
    id: "stats.evidence",
    command: "*",
    args: [
      { name: "message", required: false },
      { name: "person", required: false },
      { name: "selection", required: true },
      { name: "component", required: true },
    ],
    why: "the messages behind the top row's {component}",
  },
  {
    id: "messages.show",
    command: "messages show",
    args: [{ name: "chat", required: true }],
    why: "the message in full",
  },
  {
    id: "messages.context",
    command: "messages context",
    args: [{ name: "chat", required: true }],
    why: "the messages around it",
  },
  {
    id: "doctor.online",
    command: "doctor",
    args: [{ name: "online", required: true }],
    why: "the login was not checked; --online logs in once and sends nothing",
  },
  {
    id: "doctor.report-create",
    command: "doctor reports create",
    args: [{ name: "run", required: false }],
    why: "writes the report to a file to read and send; it holds no message text",
  },
  {
    id: "mcp.config",
    command: "mcp config",
    args: [{ name: "profiles", required: false }],
    why: "the entry names one Node version's path; after switching or upgrading Node, print it again",
  },
  {
    id: "bot.mcp-config",
    command: "bot mcp config",
    args: [],
    why: "the entry names one Node version's path; after switching or upgrading Node, print it again",
  },
  {
    id: "server.restart",
    command: "server restart",
    args: [],
    why: "serve still runs an older version; a restart runs the one installed now",
  },
  {
    id: "search.meetings",
    command: "*",
    args: [{ name: "max_meetings", required: true }],
    why: "stopped after {scanned} meetings; more may match",
  },
])

/** A step from its registered definition; an argument left undefined is left out, as the command line would. */
export const nextStep = (id: string, input: StepInput): NextStep => {
  const definition = STEPS.find((step) => step.id === id)
  if (!definition) throw new Error(`no step "${id}"`)
  const args = Object.fromEntries(Object.entries(input.args ?? {}).filter(([, value]) => value !== undefined))
  return stepOf(definition, { ...input, args })
}

/** `typedCommand` with the profile this command line named, else the run's. */
export const lineOf = (command: Command, words: string): string => {
  const root = rootOf(command)
  const profile: unknown = root.getOptionValue("profile")
  return typedCommand(root.name(), words, typeof profile === "string" && profile !== "" ? profile : undefined)
}

export const rootOf = (command: Command): Command => {
  let root = command
  while (root.parent) root = root.parent
  return root
}

/** The command a path names in this program, or nothing when this CLI does not have it. */
export const commandAt = (root: Command, path: string): Command | undefined => {
  let at: Command | undefined = root
  for (const word of path.split(" "))
    at = at?.commands.find((one) => one.name() === word || one.aliases().includes(word))
  return at === root ? undefined : at
}

export type CommandStep = Extract<NextStep, { kind: "command" }>
type Targets = NonNullable<StepInput["targets"]>

/**
 * The steps this CLI can run, at most two: a step naming a command it lacks is dropped, never printed. Whether a
 * step may run unasked is judged here, where the command tree is known: only when its command writes nothing
 * remotely.
 */
export const runnable = (root: Command, steps: readonly NextStep[] | undefined): NextStep[] =>
  withSafety(
    (steps ?? [])
      .filter((step) => step.kind === "user_action" || commandAt(root, step.command) !== undefined)
      .slice(0, MAX_NEXT_STEPS),
    judgedTargets(root),
  )

/**
 * The step a failure names, where its reason has one and this CLI has the command: a model that is not downloaded
 * names its download only in a CLI with `models`. A step the error already carries is kept, also only if runnable.
 */
export const failureSteps = (
  root: Command,
  error: { reason?: string; details?: Record<string, unknown>; next?: readonly NextStep[] },
): NextStep[] => {
  const model = error.details?.model
  const own =
    error.reason === "model.not-downloaded" && typeof model === "string"
      ? [
          nextStep(IMAGE_MODELS.some((one) => one.id === model) ? "models.download-image" : "models.download", {
            args: { model },
          }),
        ]
      : []
  return runnable(root, [...(error.next ?? []), ...own])
}

/** Each command step judged by its command's effects: safe to run unasked only when it writes nothing remotely. */
export const withSafety = (steps: readonly NextStep[], targets: Targets): NextStep[] =>
  steps.map((step) => {
    if (step.kind === "user_action") return step
    const effects = targets(step.command)?.effects
    return { ...step, safe_to_auto_execute: effects !== undefined && !writes(effects) }
  })

/** Each command step with `line`, the whole command to type — only the CLI knows the profile, so MCP gets none. */
export const withLines = (root: Command, steps: readonly NextStep[]): NextStep[] =>
  steps.map((step) => (step.kind === "command" ? { ...step, line: stepLine(root, step) } : step))

const kebab = (name: string) => name.replaceAll("_", "-")
const quoted = (value: unknown) => {
  const text = String(value)
  return /^[\w@:./+-]+$/.test(text) ? text : JSON.stringify(text)
}

/**
 * The step as a person types it: the profile the command ran with, positional arguments in their place, then the
 * options. A CLI that assumes no profile refuses the line without it.
 */
export const stepLine = (root: Command, step: CommandStep): string => {
  const command = commandAt(root, step.command)
  const positional = new Set(command?.registeredArguments.map((argument) => argument.name()) ?? [])
  const args = Object.entries(step.args).filter(([, value]) => value !== undefined && value !== false)
  const profile: unknown = root.getOptionValue("profile")
  return [
    root.name(),
    ...(typeof profile === "string" && profile !== "" ? [quoted(profile)] : []),
    step.command,
    ...(command?.registeredArguments ?? []).flatMap((argument) =>
      step.args[argument.name()] === undefined ? [] : [quoted(step.args[argument.name()])],
    ),
    ...args
      .filter(([name]) => !positional.has(name))
      .map(([name, value]) => (value === true ? `--${kebab(name)}` : `--${kebab(name)} ${quoted(value)}`)),
  ].join(" ")
}
