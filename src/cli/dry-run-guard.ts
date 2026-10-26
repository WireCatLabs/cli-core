import { metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { outputFor } from "./context.js"
import { changesAuthority } from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"
import { previewBody } from "./preview.js"

const descendants = (command: Command, into = new Set<Command>()): Set<Command> => {
  into.add(command)
  for (const child of command.commands) descendants(child, into)
  return into
}

/**
 * `run` previews a `--dry-run` before any action; a CLI with its own program may let a command through to its
 * action, as drive does for `upgrade`. This keeps a shared command that writes from writing there. Under `run`
 * its root hook throws first, so this never fires and the preview stays `run`'s.
 */
const previewWrites = (messenger: boolean) => (hooked: Command, action: Command) => {
  // Each command carries its own hook, so one a CLI moves under its own group keeps it.
  if (hooked !== action || action.optsWithGlobals<{ dryRun?: boolean }>().dryRun !== true) return
  // `run` hands the global flag to a command's own --dry-run; another host's program does not.
  if (action.options.some((option) => option.long === "--dry-run")) {
    action.setOptionValue("dryRun", true)
    return
  }
  if (!writes(metaOf(action).effects) && !changesAuthority(action)) return
  // Commander reads the handler after the hooks, so swapping it here stops the write; each run builds its program anew.
  action.action(function (this: Command) {
    renderAnswer(this, outputFor(this), itemOf(snakeKeys(previewBody(this, undefined, messenger))))
  })
}

type Identity = { command: string; messenger?: boolean }
const isIdentity = (value: unknown): value is Identity =>
  typeof value === "object" && value !== null && typeof (value as { command?: unknown }).command === "string"

/** Factories take the tool's identity, or a messenger or bot that carries it. */
const identityIn = (args: readonly unknown[]): Identity | undefined => {
  for (const arg of args) {
    if (isIdentity(arg)) return arg
    const app = (arg as { app?: unknown } | null)?.app
    if (isIdentity(app)) return app
  }
  return undefined
}

/** Wraps a shared command's factory so every command it builds or adds honours a global `--dry-run`. */
export const honoursDryRun =
  <A extends unknown[], R>(factory: (...args: A) => R) =>
  (...args: A): R => {
    const first = args[0]
    const before = first instanceof Command ? descendants(first) : new Set<Command>()
    const result = factory(...args)
    const roots = new Set<Command>()
    if (result instanceof Command) roots.add(result)
    else if (Array.isArray(result)) for (const one of result) if (one instanceof Command) roots.add(one)
    if (first instanceof Command)
      for (const command of descendants(first))
        if (!before.has(command) && command.parent && before.has(command.parent)) roots.add(command)
    const hook = previewWrites(identityIn(args)?.messenger !== false)
    for (const root of roots) for (const command of descendants(root)) command.hook("preAction", hook)
    return result
  }
