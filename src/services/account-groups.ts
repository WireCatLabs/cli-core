import { CliError } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"
import { accountsOfList, groupName, sameAs, sourceOf } from "../search/account-list.js"
import { type GroupContext, type GroupMembership, hasGroup, NOT_GROUP_NAMES, PERSONAL } from "../search/groups.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { groupLockOf, listContextOf } from "./search-kind.js"

/** The store, the account running and its app: what every group edit resolves members against. */
export interface GroupStore {
  store: MessageStore
  account: AccountKey
  app?: AppIdentity
  /** The run's environment: under a group lock only that group is listed and changed. */
  env?: NodeJS.ProcessEnv
}

export interface GroupMemberChange {
  group: string
  /** One account, as `--source` names it: `telegram:102`, `tg:work`, `email:me@work.example`. */
  member: string
  /** Words that may not name a group, such as memo's command words. */
  reserved?: ReadonlySet<string>
}

export interface GroupMemberMove extends Omit<GroupMemberChange, "group"> {
  from: string
  to: string
}

const fail = (code: "validation_error" | "not_found", message: string): never => {
  throw new CliError(code, message)
}

const contextOf = ({ store, account, app, env }: GroupStore) => listContextOf(store, account, app, undefined, env)

/** Under a lock the groups are the owner's to change, never the locked process's. */
const unlocked = (at: GroupStore) => {
  const lock = groupLockOf(at.app, at.env)
  if (lock !== undefined)
    throw new CliError(
      "permission_error",
      `this process is locked to group ${lock} — groups are changed without the lock`,
    )
}

const usableGroup = (name: string, reserved: ReadonlySet<string> = new Set()): string => {
  groupName(name)
  if (NOT_GROUP_NAMES.has(name.toLowerCase()) || reserved.has(name))
    fail("validation_error", `"${name}" cannot name a group — it already means something on the command line`)
  return name
}

/** A group holds accounts, so a member is saved as the one account it names, under its stable key. */
const accountOf = (context: GroupContext, member: string): AccountKey => {
  if (member.toLowerCase().startsWith("group:")) fail("validation_error", "a group lists accounts, not other groups")
  const accounts = accountsOfList(member, { ...context, groups: {} })
  if (accounts.length !== 1)
    fail(
      "validation_error",
      `${member} names ${accounts.length} accounts — name one: ${accounts.map(sourceOf).join(", ")}`,
    )
  return accounts[0] as AccountKey
}

/**
 * Whether a saved entry is to go when `key` leaves its group: every entry naming only this account does. One that
 * names more, such as a bare `email`, would take the others with it, so the change is refused instead.
 */
const namesOnly = (context: GroupContext, key: AccountKey) => (entry: string) => {
  let accounts: AccountKey[]
  try {
    accounts = accountsOfList(entry, { ...context, groups: {} })
  } catch {
    return false
  }
  if (!accounts.some(sameAs(key))) return false
  if (accounts.length > 1)
    fail("validation_error", `${entry} names more than this account — change the group with config set`)
  return true
}

const isIn = (context: GroupContext, group: string, key: AccountKey): boolean => {
  if (!hasGroup(context.membership.groups, group))
    fail("not_found", `no group "${group}" — groups here: ${Object.keys(context.membership.groups).join(", ")}`)
  return (context.membership.groups[group] ?? []).some(sameAs(key))
}

/** Every group with its members, why each is in, its profiles and other groups, the duplicates and the suggestions. */
export const listAccountGroups = async (at: GroupStore): Promise<GroupMembership> => (await contextOf(at)).membership

export const addGroupMember = async (at: GroupStore, change: GroupMemberChange): Promise<GroupMembership> => {
  unlocked(at)
  const group = usableGroup(change.group, change.reserved)
  const key = accountOf(await contextOf(at), change.member)
  await at.store.accounts.changeAccountGroups({ add: { group, entry: sourceOf(key) } })
  return listAccountGroups(at)
}

export const removeGroupMember = async (at: GroupStore, change: GroupMemberChange): Promise<GroupMembership> => {
  unlocked(at)
  const context = await contextOf(at)
  const key = accountOf(context, change.member)
  const member = isIn(context, change.group, key)
  const { removed } = await at.store.accounts.changeAccountGroups({
    remove: { group: change.group, drop: namesOnly(context, key) },
  })
  if (removed.length === 0)
    fail(
      member ? "validation_error" : "not_found",
      member
        ? `${change.member} is in ${PERSONAL} because it is in no other group — add it to one to take it out`
        : `${change.member} is not in group ${change.group}`,
    )
  return listAccountGroups(at)
}

/** Out of one group and into another in one write: what a drag between groups does. */
export const moveGroupMember = async (at: GroupStore, move: GroupMemberMove): Promise<GroupMembership> => {
  unlocked(at)
  const to = usableGroup(move.to, move.reserved)
  const context = await contextOf(at)
  const key = accountOf(context, move.member)
  if (!isIn(context, move.from, key)) fail("not_found", `${move.member} is not in group ${move.from}`)
  await at.store.accounts.changeAccountGroups({
    remove: { group: move.from, drop: namesOnly(context, key) },
    add: { group: to, entry: sourceOf(key) },
  })
  return listAccountGroups(at)
}
