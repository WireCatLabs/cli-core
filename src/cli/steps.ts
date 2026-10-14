import {
  STEPS as BASE_STEPS,
  defineSteps,
  MAX_NEXT_STEPS,
  type NextStep,
  type StepInput,
  stepOf,
} from "@wirecat/cli-base/standards"
import type { Command } from "commander"

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
      { name: "background", required: false },
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
    command: "models text download",
    args: [{ name: "model", required: true }],
    why: "{model} is not downloaded, so nothing is searched by meaning",
  },
  {
    id: "models.download-image",
    command: "models image download",
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
    command: "store reindex",
    args: [],
    why: "the stems were built by another stemmer; this builds them again",
  },
  {
    id: "conversations.build",
    command: "conversations build",
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
    command: "doctor report create",
    args: [{ name: "run", required: false }],
    why: "writes the report to a file to read and send; it holds no message text",
  },
  {
    id: "mcp.config",
    command: "mcp config",
    args: [],
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

export const nextStep = (id: string, input: StepInput): NextStep => {
  const definition = STEPS.find((step) => step.id === id)
  if (!definition) throw new Error(`no step "${id}"`)
  return stepOf(definition, input)
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

/** The steps this CLI can run, at most three: a step naming a command it lacks is dropped, never printed. */
export const runnable = (root: Command, steps: readonly NextStep[] | undefined): NextStep[] =>
  (steps ?? []).filter((step) => commandAt(root, step.command) !== undefined).slice(0, MAX_NEXT_STEPS)

const kebab = (name: string) => name.replaceAll("_", "-")
const quoted = (value: unknown) => {
  const text = String(value)
  return /^[\w@:./+-]+$/.test(text) ? text : JSON.stringify(text)
}

/** The step as a person types it: positional arguments in their place, then the options. */
export const stepLine = (root: Command, step: NextStep): string => {
  const command = commandAt(root, step.command)
  const positional = new Set(command?.registeredArguments.map((argument) => argument.name()) ?? [])
  const args = Object.entries(step.args).filter(([, value]) => value !== undefined && value !== false)
  return [
    root.name(),
    step.command,
    ...(command?.registeredArguments ?? []).flatMap((argument) =>
      step.args[argument.name()] === undefined ? [] : [quoted(step.args[argument.name()])],
    ),
    ...args
      .filter(([name]) => !positional.has(name))
      .map(([name, value]) => (value === true ? `--${kebab(name)}` : `--${kebab(name)} ${quoted(value)}`)),
  ].join(" ")
}
