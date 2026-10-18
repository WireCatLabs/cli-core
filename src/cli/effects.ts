import { annotate, annotateOption, stepTargets } from "@wirecat/cli-base/commands"
import type { Effects, StepInput } from "@wirecat/cli-base/standards"
import { type Command, Option } from "commander"
import { type AppIdentity, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
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

const AUTHORITY = new WeakSet<Command>()

/**
 * Marks a local write that changes what a later run may do: a schedule, a setting, the recipient list, an
 * auto-reply, an agent's setup. `<PREFIX>_READ_ONLY` refuses it, or an agent under the lock could hand an
 * unlocked run the send it may not make itself (SEC-47). For the same reason no MCP server offers it (`mcp: false`).
 */
export const grantsAuthority = <T extends Command>(command: T): T => {
  AUTHORITY.add(command)
  return annotate(command, { mcp: false })
}

export const changesAuthority = (command: Command): boolean => AUTHORITY.has(command)

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

const STORE_CHANGE = new WeakSet<Command>()

/**
 * Marks a command that replaces, deletes or rewrites the message store or a file made from it, or that writes what
 * the owner saved in it (saved searches, aliases, contact notes). The store is the owner's archive, so `<PREFIX>_READ_ONLY` refuses it even
 * though nothing leaves the machine; `--dry-run` still previews it. What the store can rebuild from its messages —
 * jobs, conversation links, vectors — is not marked.
 */
export const changesStore = <T extends Command>(command: T): T => {
  STORE_CHANGE.add(command)
  return command
}

export const isStoreChange = (command: Command): boolean => STORE_CHANGE.has(command)

export const STORE_CHANGE_REFUSAL = "change the message store"

/** Under `<PREFIX>_READ_ONLY`, refuses a change `changesStore` marks — for a caller outside `run()`, an MCP tool. */
export const refuseStoreChange = (app: AppIdentity, env: NodeJS.ProcessEnv): void => {
  const lock = readOnlyLockOf(app, env)
  if (lock) throw readOnlyRefusal(lock, STORE_CHANGE_REFUSAL)
}

const OTHER_SERVICE = new WeakSet<Command>()

/**
 * Marks a command whose remote side is a service other than the messenger — an embedding or analysis provider, a
 * model host. Its effects still say what leaves the machine, but serve's relay has no connection to lend it, so it
 * always runs here.
 */
export const reachesOtherService = <T extends Command>(command: T): T => {
  OTHER_SERVICE.add(command)
  return command
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
 * nothing remotely and writes here (`server restart`, `store reindex`) is the whole point of the step, so it waits
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
