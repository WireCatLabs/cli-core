import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { INTERNAL_NOTES } from "../domain/providers.js"
import { looksLikeReference, SIMPLE_REFERENCES, type SimpleReference } from "../domain/references.js"
import { type AppIdentity, envName } from "../ports/app.js"
import { inGroupOf } from "../search/groups.js"
import { groupLockOf, listContextOf } from "../services/search-kind.js"
import { type MessageStore, openStore } from "../store/store.js"
import { PROFILE_FREE } from "./profile.js"

const keepsToGroup = new WeakSet<Command>()

/**
 * Marks a command, and every command under it, as one that keeps to the run's account group: it scopes its reads
 * and writes with `scopeToGroup`. Under `<PREFIX>_GROUP_LOCK` every other command is refused (WC-ACCT-13).
 */
export const groupAware = <T extends Command>(command: T): T => {
  keepsToGroup.add(command)
  return command
}

export const isGroupAware = (command: Command): boolean => {
  let top: Command | undefined
  for (let at: Command | null = command; at?.parent; at = at.parent) {
    if (keepsToGroup.has(at)) return true
    top = at
  }
  return top !== undefined && PROFILE_FREE.has(top.name())
}

const valuesOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(valuesOf) : []

const declared = new WeakMap<Command, Readonly<Record<string, SimpleReference>>>()

/**
 * The kind of thing a bare id names, per argument (by its name) or option (by its long flag):
 * `refKinds(show, { organization: "organization", "--note": "note" })`. An argument or a `--<kind>` option named
 * after a kind needs no entry. Under the lock a bare value there is checked as `<kind>:<value>`; a command that
 * declares nothing has a bare number in an argument refused, since what it names is unknown. `{}` says no argument
 * takes an id.
 */
export const refKinds = <T extends Command>(command: T, kinds: Readonly<Record<string, SimpleReference>>): T => {
  declared.set(command, kinds)
  return command
}

const isSimpleReference = (name: string): name is SimpleReference =>
  (SIMPLE_REFERENCES as readonly string[]).includes(name)

const kindAt = (command: Command, name: string, implicit: string): SimpleReference | undefined =>
  declared.get(command)?.[name] ?? (isSimpleReference(implicit) ? implicit : undefined)

const BARE_NUMBER = /^\d+$/

/**
 * Every reference typed into the run: each word of each argument and option value that is a reference, and each bare
 * id in a position whose kind is known, as `<kind>:<id>`. `unknown` holds the arguments with a bare number of a
 * command that declares no kinds.
 */
export const referencesIn = (command: Command): { references: string[]; unknown: string[] } => {
  const references = new Set<string>()
  const unknown: string[] = []
  const typed = (value: string, kind: SimpleReference | undefined, onBare?: () => void) => {
    for (const word of value.split(/[\s,]+/).filter(Boolean)) {
      if (looksLikeReference(word)) references.add(word)
      else if (kind !== undefined && !word.includes(":")) references.add(`${kind}:${word}`)
      else if (BARE_NUMBER.test(word)) onBare?.()
    }
  }
  command.registeredArguments.forEach((argument, at) => {
    const name = argument.name()
    for (const value of valuesOf(command.processedArgs[at] ?? command.args[at]))
      typed(value, kindAt(command, name, name), () => {
        if (!declared.has(command)) unknown.push(`<${name}> ${value}`)
      })
  })
  for (const option of command.options) {
    const long = option.long ?? ""
    for (const value of valuesOf(command.getOptionValue(option.attributeName())))
      typed(value, kindAt(command, long, long.replace(/^--/, "")))
  }
  return { references: [...references], unknown }
}

const pathOf = (command: Command): string => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words.join(" ")
}

/**
 * Under `<PREFIX>_GROUP_LOCK`, refuses a command that does not keep to a group, and a reference whose thing belongs
 * only to accounts outside the group. A thing no account brought is the owner's and passes; a note written in memo
 * belongs to `personal`; a person passes when one of their identities is in the group.
 */
export const refuseOutsideGroup = async (
  command: Command,
  { app, env, store }: { app: AppIdentity; env: NodeJS.ProcessEnv; store?: MessageStore },
): Promise<void> => {
  const lock = groupLockOf(app, env)
  if (lock === undefined) return
  const locked = `this process is locked to group ${lock} (${envName(app, "GROUP_LOCK")})`
  if (!isGroupAware(command))
    throw new CliError(
      "permission_error",
      `${locked} — \`${app.command} ${pathOf(command)}\` does not keep to a group, so it does not run`,
      { group: lock },
    )
  const { references, unknown } = referencesIn(command)
  if (unknown.length)
    throw new CliError(
      "permission_error",
      `${locked} — \`${app.command} ${pathOf(command)}\` takes ${unknown.join(", ")} as an id of a kind it does not ` +
        "declare, so it cannot be checked against the group",
      { group: lock },
    )
  if (references.length === 0) return
  const opened = store ?? (await openStore({ env, command: app.command, version: app.version }))
  try {
    const context = await listContextOf(opened, { provider: "notes", account: INTERNAL_NOTES }, app, undefined, env)
    const inGroup = inGroupOf(context, lock)
    for (const reference of references) {
      const accounts = await opened.refs.accounts(reference)
      if (accounts?.length && !accounts.some(inGroup))
        throw new CliError("permission_error", `${locked} — ${reference} belongs to an account outside it`, {
          group: lock,
          reference,
        })
    }
  } finally {
    if (!store) await opened.close()
  }
}
