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

/**
 * What a bare id names: a referenced thing's kind, a proposed action (`action`, as `actions confirm 17` takes it), or
 * a proposal id of the review registry (`proposal`: `17070`, `17080/f1`, `link:17`, `fact:512`).
 */
export type RefKind = SimpleReference | "action" | "proposal"

const declared = new WeakMap<Command, Readonly<Record<string, RefKind>>>()

/**
 * The kind of thing a bare id names, per argument (by its name) or option (by its long flag):
 * `refKinds(show, { organization: "organization", "--note": "note" })`. An argument or a `--<kind>` option named
 * after a kind needs no entry. Under the lock a bare value there is checked as `<kind>:<value>`; a command that
 * declares nothing has any other argument value refused, since what it names is unknown (`1e0`, `+1`, `link:1`).
 * `{}` says no argument takes an id, so free text passes.
 */
export const refKinds = <T extends Command>(command: T, kinds: Readonly<Record<string, RefKind>>): T => {
  declared.set(command, kinds)
  return command
}

const isSimpleReference = (name: string): name is SimpleReference =>
  (SIMPLE_REFERENCES as readonly string[]).includes(name)

const kindAt = (command: Command, name: string, implicit: string): RefKind | undefined =>
  declared.get(command)?.[name] ?? (isSimpleReference(implicit) ? implicit : undefined)

/**
 * Every reference typed into the run: each word of each argument and option value that is a reference, and each bare
 * id in a position whose kind is known, as `<kind>:<id>`. `unknown` holds every other argument value of a command
 * that declares no kinds.
 */
export const referencesIn = (command: Command): { references: string[]; unknown: string[] } => {
  const references = new Set<string>()
  const unknown: string[] = []
  const typed = (value: string, kind: RefKind | undefined, onBare?: () => void) => {
    for (const word of value.split(/[\s,]+/).filter(Boolean)) {
      const stored = /^([1-9]\d*)(?:\/[\w-]+)?$/.exec(word)?.[1]
      const proposalKind = kind === "action" || kind === "proposal"
      if (looksLikeReference(word) || (proposalKind && PROPOSAL_REF.test(word))) references.add(word)
      else if (proposalKind && stored) references.add(`action:${stored}`)
      // A key-document suggestion is a link between the document and its project, so both ends are checked.
      else if (kind === "proposal" && /^key:[1-9]\d*$/.test(word)) references.add(`link:${word.slice(4)}`)
      // A close suggestion is its task's, which the owner made; the task's evidence is stripped where it is shown.
      else if (kind === "proposal" && word.startsWith("close:")) references.add(`task:${word.slice(6)}`)
      else if (kind !== undefined && kind !== "proposal" && !word.includes(":")) references.add(`${kind}:${word}`)
      else onBare?.()
    }
  }
  command.registeredArguments.forEach((argument, at) => {
    const name = argument.name()
    const kind = kindAt(command, name, name)
    for (const value of valuesOf(command.processedArgs[at] ?? command.args[at]))
      typed(value, kind, () => {
        // A proposal id of no kind the lock knows cannot be checked, so it is refused even where kinds are declared.
        const named = `<${name}> ${value}`
        if ((!declared.has(command) || kind === "proposal") && !unknown.includes(named)) unknown.push(named)
      })
  })
  for (const option of command.options) {
    const long = option.long ?? ""
    for (const value of valuesOf(command.getOptionValue(option.attributeName())))
      typed(value, kindAt(command, long, long.replace(/^--/, "")))
  }
  return { references: [...references], unknown }
}

const PROPOSAL_REF = /^(action|link):[1-9]\d*$/

const pathOf = (command: Command): string => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words.join(" ")
}

/**
 * Under `<PREFIX>_GROUP_LOCK`, refuses a command that does not keep to a group, and a reference whose thing belongs
 * only to accounts outside the group. A thing no account brought is the owner's and passes in every group, a note
 * written in memo included; a person passes when one of their identities is in the group.
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
      const ends = await opened.refs.ends(reference)
      if (ends?.some((end) => end.length > 0 && !end.some(inGroup)))
        throw new CliError("permission_error", `${locked} — ${reference} belongs to an account outside it`, {
          group: lock,
          reference,
        })
    }
  } finally {
    if (!store) await opened.close()
  }
}
