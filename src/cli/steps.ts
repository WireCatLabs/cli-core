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
    id: "chats.members",
    command: "chats members list",
    args: [{ name: "chat", required: true }],
    why: "the chat's member list has everyone it lets you see",
  },
  {
    id: "models.download",
    command: "models text download",
    args: [{ name: "model", required: true }],
    why: "{model} is not downloaded, so nothing is searched by meaning",
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
