import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { INTERNAL_NOTES } from "../domain/providers.js"
import { looksLikeReference } from "../domain/references.js"
import { type AppIdentity, envName } from "../ports/app.js"
import { keyOf, sameAs } from "../search/account-list.js"
import { PERSONAL } from "../search/groups.js"
import { groupLockOf, listContextOf } from "../services/search-kind.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
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

/** Every reference typed into the run: each argument and option value, word by word and item by item. */
export const referencesIn = (command: Command): string[] => [
  ...new Set(
    [...valuesOf(command.args), ...Object.values(command.opts()).flatMap(valuesOf)]
      .flatMap((value) => value.split(/[\s,]+/))
      .filter(looksLikeReference),
  ),
]

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
  const references = referencesIn(command)
  if (references.length === 0) return
  const opened = store ?? (await openStore({ env, command: app.command, version: app.version }))
  try {
    const context = await listContextOf(opened, { provider: "notes", account: INTERNAL_NOTES }, app, undefined, env)
    const members = new Set((context.membership.groups[lock] ?? []).map(keyOf))
    const inGroup = (key: AccountKey) =>
      members.has(keyOf(key)) || (lock === PERSONAL && sameAs({ provider: "notes", account: INTERNAL_NOTES })(key))
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
