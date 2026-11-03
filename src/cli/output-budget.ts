import type { NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { entityRows, GENERIC_ROW, rowShapeOf } from "./compact.js"
import { environmentOf } from "./context.js"
import { rootOf } from "./steps.js"

/** About a third of a 200k-token context at ~3 bytes per token (inferred, not measured). */
export const SOFT_OUTPUT_BYTES = 256 * 1024

const CARRIED = ["json", "compact", "offline", "timeout", "full", "brief", "maxOutputBytes"] as const
const NOT_WITH_COMPACT = new Set(["json", "brief"])

const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

const typed = (command: Command, key: string) => command.getOptionValueSource(key) === "cli"

/**
 * The words the caller typed, as step arguments: never a default, never text an answer carried (WC-OUT-9). A
 * `--no-x` flag and `--json=<fields>` have no form a step can carry, so a line holding one gets no step.
 */
const typedArgs = (command: Command): Record<string, unknown> | undefined => {
  const root = rootOf(command)
  if (root.getOptionValue("fields") !== undefined) return undefined
  if (command.options.some((option) => option.negate && typed(command, option.attributeName()))) return undefined
  const positional = command.registeredArguments.flatMap((argument, index) => {
    const value: unknown = command.processedArgs[index]
    const word = Array.isArray(value) ? value.join(" ") : value
    return word === undefined || word === "" ? [] : [[argument.name(), word]]
  })
  const own = command.options
    .map((option) => option.attributeName())
    .filter((key) => typed(command, key))
    .map((key) => [snake(key), command.getOptionValue(key)])
  const global = CARRIED.filter((key) => typed(root, key)).map((key) => [snake(key), root.getOptionValue(key)])
  return Object.fromEntries([...positional, ...own, ...global])
}

const declaresRow = (command: Command) => {
  const { rows } = environmentOf(command)
  return rowShapeOf(command, rows && entityRows(rows)) !== GENERIC_ROW
}

const pathOf = (command: Command): string => {
  const words: string[] = []
  for (let at: Command | null = command; at.parent; at = at.parent) words.unshift(at.name())
  return words.join(" ")
}

const step = (command: Command, id: string, args: Record<string, unknown>, why: string): NextStep => ({
  kind: "command",
  step: id,
  command: pathOf(command),
  args,
  why,
  safe_to_auto_execute: true,
})

const compactStep = (command: Command, args: Record<string, unknown>, why: string): NextStep[] =>
  rootOf(command).getOptionValue("compact") === true || !declaresRow(command)
    ? []
    : [
        step(
          command,
          "output.compact",
          { ...Object.fromEntries(Object.entries(args).filter(([key]) => !NOT_WITH_COMPACT.has(key))), compact: true },
          why,
        ),
      ]

/** The same read in a form that fits the cap: one line per item, then a `--limit` scaled down to fit (WC-OUT-22). */
export const tooLargeSteps = (
  command: Command,
  { maxBytes, neededBytes }: { maxBytes: number; neededBytes: number },
) => {
  const args = typedArgs(command)
  if (!args) return []
  const limit = Number(command.getOptionValue("limit"))
  const fits = Math.floor(((limit * maxBytes) / neededBytes) * 0.9)
  return [
    ...compactStep(command, args, "the answer is over the output cap as JSON; one line per item keeps every ref"),
    ...(Number.isSafeInteger(limit) && fits >= 1 && fits < limit
      ? [step(command, "output.limit", { ...args, limit: fits }, `about ${fits} items fit under the output cap`)]
      : []),
  ]
}

/** The step a large JSON answer adds: the same read, one line per item. */
export const largeAnswerSteps = (command: Command): NextStep[] => {
  const args = typedArgs(command)
  return args ? compactStep(command, args, "the answer is large as JSON; one line per item keeps every ref") : []
}
