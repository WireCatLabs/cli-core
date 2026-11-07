import { CliError } from "@wirecat/cli-base"
import { INTERNAL_NOTES } from "../domain/providers.js"
import type { AccountKey } from "../store/store.js"
import {
  type AccountGroups,
  accountsOfList,
  isGroupName,
  keyOf,
  type ListContext,
  sameAs,
  sourceOf,
} from "./account-list.js"

export const PERSONAL = "personal"

/** Words a source list already gives a meaning of its own, so no group may take them. */
export const NOT_GROUP_NAMES: ReadonlySet<string> = new Set(["all", "bots"])

/** `setting`: a saved group lists it; `in no other group`: `personal` holds it as the rest. */
export type GroupReason = "setting" | "in no other group"

export interface GroupMember extends AccountKey {
  /** Every saved entry that names it, or its `provider:account` when `personal` holds it as the rest. */
  entries: string[]
  reason: GroupReason
  /** Every profile recorded for the account, as `<app> <profile>`. */
  profiles: string[]
  /** The other groups that hold it too: allowed, and shown so the owner sees it. */
  also_in: string[]
}

/** A profile name another app's profile or a saved group shares, for an account not in that group: never applied. */
export interface GroupSuggestion {
  group: string
  member: string
  because: string
}

export interface GroupMembership {
  groups: Record<string, GroupMember[]>
  /** Each account in more than one group, with those groups. */
  duplicates: { member: string; groups: string[] }[]
  suggested: GroupSuggestion[]
  /** Saved entries that name no account: `personal`, the rest, may then hold what they meant. */
  unresolved: string[]
}

/** A source-list context whose `groups` include `personal`, with who is in each group and why. */
export interface GroupContext extends ListContext {
  membership: GroupMembership
}

export const hasGroup = (groups: object, name: string): boolean => Object.hasOwn(groups, name)

const membersOf = (entries: readonly string[], context: ListContext, unresolved: string[]): GroupMember[] => {
  const members = new Map<string, GroupMember>()
  for (const entry of entries)
    try {
      for (const { provider, account } of accountsOfList(entry, context)) {
        const known = members.get(keyOf({ provider, account }))
        if (known) known.entries.push(entry)
        else
          members.set(keyOf({ provider, account }), {
            provider,
            account,
            entries: [entry],
            reason: "setting",
            profiles: [],
            also_in: [],
          })
      }
    } catch (error) {
      // One stale entry must not break every read of every group; the group's own read still names it.
      if (!(error instanceof CliError)) throw error
      unresolved.push(entry)
    }
  return [...members.values()]
}

/**
 * Who is in each group (WC-ACCT-13): a saved `account_groups.<name>` is its whole list, and `personal` is every
 * account in no other saved group plus any `account_groups.personal` lists — with nothing saved, every account but
 * memo's own notes and an unsaved running account. One
 * account may be in several groups. A profile's name never puts an account in a group; it is only `suggested`.
 */
export const groupMembership = (context: ListContext): GroupMembership => {
  const plain = { ...context, groups: {} }
  const unresolved: string[] = []
  const groups: Record<string, GroupMember[]> = {}
  for (const [name, entries] of Object.entries(context.groups))
    if (name !== PERSONAL) groups[name] = membersOf(entries, plain, unresolved)
  const own = membersOf(context.groups[PERSONAL] ?? [], plain, unresolved)
  const taken = new Set([...Object.values(groups).flat(), ...own].map(keyOf))
  // Not accounts of anyone's: memo's own notes, and the row a fresh store lacks for the account running (id 0).
  const system = [{ provider: "notes", account: INTERNAL_NOTES }, ...context.held.filter(({ id }) => id === 0)].map(
    keyOf,
  )
  const rest = accountsOfList("all", plain)
    .filter((one) => !taken.has(keyOf(one)) && !system.includes(keyOf(one)))
    .map(
      ({ provider, account }): GroupMember => ({
        provider,
        account,
        entries: [sourceOf({ provider, account })],
        reason: "in no other group",
        profiles: [],
        also_in: [],
      }),
    )
  groups[PERSONAL] = [...own, ...rest]
  const recorded = Object.entries(context.profiles).flatMap(([app, named]) =>
    Object.entries(named).map(([profile, key]) => ({ app, profile, key })),
  )
  const holding = new Map<string, string[]>()
  for (const [name, members] of Object.entries(groups))
    for (const one of members) holding.set(keyOf(one), [...(holding.get(keyOf(one)) ?? []), name])
  for (const [name, members] of Object.entries(groups))
    for (const one of members) {
      one.profiles = recorded.filter(({ key }) => sameAs(key)(one)).map(({ app, profile }) => `${app} ${profile}`)
      one.also_in = (holding.get(keyOf(one)) ?? []).filter((other) => other !== name)
    }
  const duplicates = [...holding.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([key, names]) => ({ member: key.replace("\u0000", ":"), groups: names }))
  // A name only one app uses, such as `default`, says nothing about which accounts belong together.
  const shared = (app: string, profile: string) =>
    hasGroup(context.groups, profile) || recorded.some((other) => other.app !== app && other.profile === profile)
  const suggested = recorded
    .filter(
      ({ app, profile, key }) =>
        isGroupName(profile) &&
        profile !== PERSONAL &&
        !NOT_GROUP_NAMES.has(profile.toLowerCase()) &&
        shared(app, profile) &&
        !holding.get(keyOf(key))?.includes(profile),
    )
    .map(({ app, profile, key }) => ({
      group: profile,
      member: sourceOf(key),
      because: `profile named ${profile} (${app} ${profile})`,
    }))
  return { groups, duplicates, suggested, unresolved }
}

/**
 * Whether an account is in `group`: a member, or memo's own notes for `personal`, the one group that holds them.
 * `context` is a `listContextOf`.
 */
export const inGroupOf =
  (context: GroupContext, group: string) =>
  (key: AccountKey): boolean =>
    (hasGroup(context.membership.groups, group) ? (context.membership.groups[group] ?? []) : []).some(sameAs(key)) ||
    (group === PERSONAL && sameAs({ provider: "notes", account: INTERNAL_NOTES })(key))

/** The groups as a source list reads them: saved entries as written, `personal` with the rest added. */
export const groupEntries = (saved: AccountGroups, { groups }: GroupMembership): AccountGroups => ({
  ...saved,
  [PERSONAL]: [
    ...(saved[PERSONAL] ?? []),
    ...(groups[PERSONAL] ?? []).filter(({ reason }) => reason === "in no other group").map(sourceOf),
  ],
})

/** The group a run is scoped to, where it was named, and whether a lock pins it. */
export interface RunGroup {
  name: string
  from: string
  locked: boolean
}

export interface GroupRequest {
  source?: string
  account?: string
}

const fail = (code: "validation_error" | "permission_error", message: string, details?: Record<string, unknown>) => {
  throw new CliError(code, message, details)
}

const unknownGroup = (run: RunGroup, context: GroupContext): never => {
  const names = Object.keys(context.groups)
  const unknown =
    run.from === "first word"
      ? `"${run.name}" is neither a command nor a group`
      : `no group "${run.name}" (${run.from})`
  const suggested = context.membership.suggested.filter(({ group }) => group === run.name)
  const offer = suggested.length
    ? `; profiles named ${run.name} suggest ${suggested.map(({ member }) => member).join(", ")}`
    : ""
  return fail("validation_error", `${unknown} — groups here: ${names.join(", ")}${offer}`, {
    groups: names,
    ...(suggested.length ? { suggested } : {}),
  })
}

/**
 * A run in a group reads only the group: no `--source` becomes `group:<name>`, a bare provider or kind keeps the
 * group's accounts of it, and an account outside the group is refused, as is a write's `--account`. `context` is a
 * `listContextOf`. Without a lock this is a convenience, not a boundary.
 */
export const scopeToGroup = (run: RunGroup, request: GroupRequest, context: GroupContext): GroupRequest => {
  if (!hasGroup(context.groups, run.name)) unknownGroup(run, context)
  const code = run.locked ? "permission_error" : "validation_error"
  const why = run.locked
    ? `this process is locked to group ${run.name} (${run.from})`
    : `this run is in group ${run.name}`
  const { unresolved } = context.membership
  if (run.locked && run.name === PERSONAL && unresolved.length)
    fail(
      "permission_error",
      `${why}, and ${unresolved.join(", ")} name no account, so personal may hold what they meant — fix the ` +
        "group or the profile first",
    )
  const inGroup = new Set(accountsOfList(`group:${run.name}`, context).map(keyOf))
  if (inGroup.size === 0) fail("validation_error", `group ${run.name} is empty`)
  const outside = (accounts: readonly AccountKey[]) => accounts.filter((one) => !inGroup.has(keyOf(one)))
  // Under a lock the context holds only the group, so a name outside it fails to resolve: that is the refusal.
  const namedBy = (item: string): AccountKey[] => {
    try {
      return accountsOfList(item, context)
    } catch (error) {
      if (run.locked && error instanceof CliError) return []
      throw error
    }
  }
  const scoped: GroupRequest = {}
  if (request.source === undefined) scoped.source = `group:${run.name}`
  else {
    const items = request.source.split(",").map((item) => item.trim())
    if (items.some((item) => item.toLowerCase() === "all")) fail(code, `${why} — --source all reads outside it`)
    const kept: string[] = []
    let narrowed = false
    for (const item of items) {
      const accounts = namedBy(item)
      const away = outside(accounts)
      if (item.includes(":") && (away.length || accounts.length === 0))
        fail(code, `${why} — ${item} is outside it${away.length ? ` (${away.map(sourceOf).join(", ")})` : ""}`)
      if (away.length) narrowed = true
      for (const one of accounts) if (inGroup.has(keyOf(one))) kept.push(sourceOf(one))
    }
    if (kept.length === 0) fail("validation_error", `${why} — --source ${request.source} names none of its accounts`)
    scoped.source = narrowed ? [...new Set(kept)].join(",") : request.source
  }
  if (request.account !== undefined) {
    const accounts = namedBy(request.account)
    if (accounts.length === 0 || outside(accounts).length)
      fail(code, `${why} — --account ${request.account} is outside it`)
    scoped.account = request.account
  }
  return scoped
}
