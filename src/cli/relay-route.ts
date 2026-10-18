import { isAbsolute, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { type Lock, lockPath, readLock } from "../background/lock.js"
import { alive } from "../background/processes.js"
import { RELAY_PROTOCOL } from "../background/relay.js"
import type { AppIdentity } from "../ports/app.js"
import { commandPathOf } from "./command-contract.js"
import { isLogin, isOtherServiceCall } from "./effects.js"

/** Not through serve: serve itself, its unit, and what has no messenger profile. */
const LOCAL_ROOTS = new Set(["serve", "server", "bot"])

export interface RelayTarget {
  lock: Lock & { relay: NonNullable<Lock["relay"]> }
  profile: string
}

/**
 * The serve that runs this command for us, when one holds the profile's connection and offers its relay. Only a
 * command that reaches the messenger goes; one that reads or writes this machine alone runs here, as does a login
 * or a logout.
 */
export const relayTarget = (
  app: AppIdentity,
  action: Command,
  flags: { offline?: boolean; http?: boolean },
  profileOf: () => string | undefined,
  env: NodeJS.ProcessEnv,
): RelayTarget | undefined => {
  const { effects, lifetime } = metaOf(action)
  if (
    effects === undefined ||
    effects.remote === "none" ||
    lifetime === "interactive" ||
    isLogin(action) ||
    isOtherServiceCall(action)
  )
    return undefined
  const path = commandPathOf(action)
  if (LOCAL_ROOTS.has(path[0] ?? "") || flags.offline === true) return undefined
  if (path[0] === "mcp" && flags.http === true) return undefined
  let profile: string | undefined
  try {
    profile = profileOf()
  } catch {
    return undefined
  }
  if (profile === undefined) return undefined
  const lock = readLock(lockPath(app, profile, env))
  if (lock?.relay === undefined || !alive(lock.pid)) return undefined
  if (lock.relay.protocol !== RELAY_PROTOCOL) {
    throw new CliError(
      "provider_unavailable",
      `${app.command} ${profile} serve (PID ${lock.pid}) runs another version of the relay — restart it: ` +
        `\`${app.command} ${profile} server restart\``,
      { retryable: false, sent: false },
    )
  }
  return { lock: lock as RelayTarget["lock"], profile }
}

const PATH_NAME = /^(file|path|dir|directory|folder)s?$/
const PATH_PLACEHOLDER = /[<[](file|path|dir|directory|folder)s?(\.\.\.)?[>\]]/

const absolute = (cwd: string, value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((one) => absolute(cwd, one))
  if (typeof value !== "string" || value === "-" || value === "" || isAbsolute(value) || value.includes("://"))
    return value
  return resolve(cwd, value)
}

/**
 * A command serve runs for a client reads the client's files: a value whose placeholder names a path is made
 * absolute against the client's working directory before the action sees it.
 */
export const absolutePaths = (action: Command, cwd: string): void => {
  for (let at: Command | null = action; at; at = at.parent) {
    for (const option of at.options) {
      if (!PATH_PLACEHOLDER.test(option.flags)) continue
      const key = option.attributeName()
      const value = at.getOptionValue(key)
      if (value !== undefined) at.setOptionValueWithSource(key, absolute(cwd, value), at.getOptionValueSource(key))
    }
  }
  action.registeredArguments.forEach((argument, index) => {
    if (PATH_NAME.test(argument.name())) action.processedArgs[index] = absolute(cwd, action.processedArgs[index])
  })
}
