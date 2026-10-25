import { annotate, annotateOption, type CommandInfo, metaOf, stepTargets } from "@wirecat/cli-base/commands"
import type { Effects, StepInput } from "@wirecat/cli-base/standards"
import { type Command, Option } from "commander"
import { type AppIdentity, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { keyForCommand } from "../sends/permissions.js"
import { environmentOf } from "./context.js"

/** Reads the messenger; a page it keeps on the way is incidental. */
export const REMOTE_READ: Effects = { remote: "read", local: "read" }
/** Reads the messenger to keep what it read on this machine: a sync, a download, a refresh of the store. */
export const FETCH: Effects = { remote: "read", local: "write" }
/** Changes something on the service; a guarded write also records itself here. */
export const REMOTE_WRITE: Effects = { remote: "write", local: "write" }
export const LOCAL_READ: Effects = { remote: "none", local: "read" }
export const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
export const NO_EFFECTS: Effects = { remote: "none", local: "none" }

const AUTHORITY = new WeakMap<Command, string | undefined>()

/**
 * Marks a local write that changes what a later run may do: a schedule, a setting, the recipient list, an
 * auto-reply, an agent's setup. `<PREFIX>_READ_ONLY` refuses it, or an agent under the lock could hand an
 * unlocked run the send it may not make itself (SEC-47). For the same reason an MCP server permits execution only where the
 * profile allows `mcp.authority`, which is off until the owner turns it on (NEED-1662).
 * `unless` names a flag that makes the run only look (`upgrade --check`), which the lock lets through.
 */
export const grantsAuthority = <T extends Command>(command: T, { unless }: { unless?: string } = {}): T => {
  AUTHORITY.set(command, unless)
  return command
}

export const changesAuthority = (command: Command): boolean => AUTHORITY.has(command)

/** `changesAuthority` by command path under `root`, as an MCP catalogue asks it; an unknown path is not one. */
export const changesAuthorityAt =
  (root: Command) =>
  (path: readonly string[]): boolean => {
    let at: Command | undefined = root
    for (const word of path) at = at?.commands.find((one) => one.name() === word)
    return at !== undefined && changesAuthority(at)
  }

export const changesAuthorityNow = (command: Command): boolean => {
  if (!AUTHORITY.has(command)) return false
  const unless = AUTHORITY.get(command)
  return unless === undefined || command.opts()[unless] !== true
}

const LOGIN = new WeakSet<Command>()

/**
 * Marks a command that links or unlinks the account — `session start`, `session end`, a setup that logs in. It never
 * runs through serve's relay, where it would log serve's own connection in or out, and `<PREFIX>_READ_ONLY` refuses
 * it before it connects.
 */
export const logsInOrOut = <T extends Command>(command: T): T => {
  LOGIN.add(command)
  return command
}

export const isLogin = (command: Command): boolean => LOGIN.has(command)

const KEPT_UNDER_LOCK = new WeakSet<Command>()

/**
 * Marks a local write `<PREFIX>_READ_ONLY` lets through, because it deletes or overwrites nothing that cannot be got
 * back: what the store rebuilds from its messages (vectors, a backfill job, the mention index), a new file (a backup,
 * a chart, a report), or the task bookkeeping a scheduled agent does, which only adds, is undone by its pair
 * (merge/unmerge, claim/release) or keeps the old value in the task's history; under the lock a close only suggests.
 */
export const destroysNothing = <T extends Command>(command: T): T => {
  KEPT_UNDER_LOCK.add(command)
  return command
}

const STORE_WRITES = new WeakSet<Command>()

/** A local edit remains an edit even when it first fetches metadata from the messenger. */
export const changesStore = <T extends Command>(command: T): T => {
  STORE_WRITES.add(command)
  return command
}

/**
 * Whether `<PREFIX>_READ_ONLY` refuses the command as a change to the store. Every write that stays on this machine
 * is refused unless `destroysNothing` marks it, so a new one fails closed (WC-PERM-12). A fetch (`remote: "read"`)
 * keeps receiving, a remote write is `changesMessenger`'s, and an authority change has its own refusal.
 */
export const isStoreChange = (command: Command): boolean => {
  const effects = metaOf(command).effects
  return (
    (effects?.remote === "none" || STORE_WRITES.has(command)) &&
    effects?.local === "write" &&
    !KEPT_UNDER_LOCK.has(command) &&
    !changesAuthority(command)
  )
}

export const STORE_CHANGE_REFUSAL = "change the message store"

/** ` --dry-run` where the program has it, so an example of a command that calls a provider calls nothing. */
export const previewFlag = (program: Command): string =>
  program.options.some((option) => option.long === "--dry-run") ? " --dry-run" : ""

/** What a read-only refusal says the command would do: the store holds more than messages outside a messenger. */
export const storeChangeRefusal = (app: Pick<AppIdentity, "messenger">): string =>
  app.messenger === false ? "change the local store" : STORE_CHANGE_REFUSAL

/** Under `<PREFIX>_READ_ONLY`, refuses a change to the store — for a caller outside `run()`, an MCP tool. */
export const refuseStoreChange = (app: AppIdentity, env: NodeJS.ProcessEnv): void => {
  const lock = readOnlyLockOf(app, env)
  if (lock) throw readOnlyRefusal(lock, storeChangeRefusal(app))
}

const pathOf = (command: Command): string[] => {
  const words: string[] = []
  for (let at: Command | null = command; at.parent; at = at.parent) words.unshift(at.name())
  return words
}

/**
 * A change on the messenger, judged from the command alone, so the read-only lock refuses it before anything connects
 * (SEC-62): the send guard refuses it too, but only once the command has connected and found its chat. A server that runs until stopped, a call to another service and a login (no key) have rules of their own.
 */
export const changesMessenger = (
  command: Command | Pick<CommandInfo, "path" | "effects" | "lifetime" | "reaches">,
): boolean => {
  const { path, effects, lifetime, reaches } =
    "path" in command ? command : { path: pathOf(command), ...metaOf(command) }
  return (
    effects?.remote === "write" &&
    lifetime !== "persistent" &&
    reaches !== "other_service" &&
    Boolean(keyForCommand(path))
  )
}

const OTHER_SERVICE = new WeakSet<Command>()

/**
 * Marks a command whose remote side is a service other than the messenger — an embedding or analysis provider, a
 * model host. Its effects still say what leaves the machine, but serve's relay has no connection to lend it, so it
 * always runs here. Its description says `reaches: "other_service"`, so the commands page does not call it a change
 * in the messenger.
 */
export const reachesOtherService = <T extends Command>(command: T): T => {
  OTHER_SERVICE.add(command)
  return annotate(command, { reaches: "other_service" })
}

export const isOtherServiceCall = (command: Command): boolean => OTHER_SERVICE.has(command)

/** An option only the owner passes: MCP tools leave it out of their input (`mcp: false`). */
export const ownerOnlyOption = (flags: string, description: string): Option =>
  annotateOption(new Option(flags, description), { mcp: false })

/**
 * The effects a retry or an unasked step is judged on (NEED-1073): only what the service sees. Running a sync or a
 * cached read twice rewrites the same local rows, so a local write alone never makes either unsafe. Unknown stays
 * unknown, which cli-base counts as a write.
 */
export const judgedEffects = (effects: Effects | undefined): Effects | undefined =>
  effects && { remote: effects.remote, local: "none" }

/**
 * An unasked step is judged stricter than a retry: only a fetch's local write is incidental. A command that reads
 * nothing remotely and writes here (`server restart`, `store rebuild`) is the whole point of the step, so it waits
 * to be asked (RISK-1211).
 */
const judgedStepEffects = (effects: Effects | undefined): Effects | undefined =>
  effects?.remote === "none" ? effects : judgedEffects(effects)

/** `stepTargets`, with each command's effects judged for running unasked. */
export const judgedTargets = (root: Command): NonNullable<StepInput["targets"]> => {
  const targets = stepTargets(root)
  return (command) => {
    const target = targets(command)
    if (!target) return undefined
    const effects = judgedStepEffects(target.effects)
    return { names: target.names, ...(effects ? { effects } : {}) }
  }
}

/**
 * Refuses under `<PREFIX>_READ_ONLY` a write the send guard never sees: linking or unlinking the device (`session
 * start`, `session end`), a messenger's own setup. Call it first in the action, before anything connects.
 */
export const refuseUnderReadOnly = (command: Command, what: string): void => {
  const { app, env } = environmentOf(command)
  if (!app) throw new Error("refuseUnderReadOnly runs inside run(), which says whose lock to read")
  const lock = readOnlyLockOf(app, env ?? process.env)
  if (lock) throw readOnlyRefusal(lock, what)
}
