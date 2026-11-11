import { CliError } from "@wirecat/cli-base"
import type { Id } from "../domain/models.js"
import type { AppIdentity } from "../ports/app.js"
import { accountsOfList, groupName, sameAs, sourceOf } from "../search/account-list.js"
import { ALL, type GroupContext, type GroupMembership, hasGroup, NOT_GROUP_NAMES } from "../search/groups.js"
import type { AccountKey, MessageStore, StoredAccount } from "../store/store.js"
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

type Scope = StoredAccount["scope"]

export interface AccountScopeChange {
  /** One account, as `--source` names it: `bitrix24:acme.bitrix24.ru`, `tg:work`. */
  member: string
  scope: Scope
}

export interface ChatScopeChange {
  member: string
  /** The chat's id in that account. */
  chat: Id
  /** `null` takes the chat's own scope off, so it follows its account again. */
  scope: Scope | null
}

export interface ChatScope extends AccountKey {
  chat: Id
  /** The chat's own scope; `null` when it follows its account. */
  own: Scope | null
  /** What every reader applies: its own, or else its account's. */
  scope: Scope
}

const SCOPES: readonly Scope[] = ["personal", "work"]

const scopeOf = (scope: string): Scope => {
  if (!SCOPES.includes(scope as Scope))
    throw new CliError("validation_error", `${scope} is not a scope — personal or work`, { reason: "input.invalid" })
  return scope as Scope
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
  const group = usableGroup(change.group)
  const context = await contextOf(at)
  const key = accountOf(context, change.member)
  isIn(context, group, key)
  const { removed } = await at.store.accounts.changeAccountGroups({
    remove: { group, drop: namesOnly(context, key) },
  })
  if (removed.length === 0) fail("not_found", `${change.member} is not in group ${group}`)
  return listAccountGroups(at)
}

/** Out of one group and into another in one write: what a drag between groups does. */
export const moveGroupMember = async (at: GroupStore, move: GroupMemberMove): Promise<GroupMembership> => {
  unlocked(at)
  const to = usableGroup(move.to, move.reserved)
  const context = await contextOf(at)
  const key = accountOf(context, move.member)
  if (!isIn(context, move.from, key)) fail("not_found", `${move.member} is not in group ${move.from}`)
  // Out of `all` nothing can go: a move from it puts the account in `to` and leaves it in every account.
  await at.store.accounts.changeAccountGroups({
    ...(move.from === ALL ? {} : { remove: { group: move.from, drop: namesOnly(context, key) } }),
    add: { group: to, entry: sourceOf(key) },
  })
  return listAccountGroups(at)
}

/** A group the owner saved, by its exact name: `all` and the other built-in names are no saved group. */
const savedGroup = async (at: GroupStore, name: string): Promise<string> => {
  if (NOT_GROUP_NAMES.has(name.toLowerCase()))
    fail("validation_error", `"${name}" is built in — it cannot be renamed or deleted`)
  const saved = await at.store.accounts.accountGroups()
  if (!Object.hasOwn(saved, name))
    fail("not_found", `no group "${name}" — groups here: ${Object.keys(saved).join(", ") || "none"}`)
  return name
}

/**
 * A new name for a group, with its members. Nothing else in the store names a group: a run that still asks for the
 * old name (`MEMO_GROUP`, a lock, `--source group:`) is refused with the groups there are, never given another group.
 */
export const renameAccountGroup = async (
  at: GroupStore,
  rename: { from: string; to: string; reserved?: ReadonlySet<string> },
): Promise<GroupMembership> => {
  unlocked(at)
  const from = await savedGroup(at, rename.from)
  const to = usableGroup(rename.to, rename.reserved)
  if (hasGroup((await contextOf(at)).membership.groups, to)) fail("validation_error", `group "${to}" already exists`)
  if (!(await at.store.accounts.renameAccountGroup(from, to))) fail("validation_error", `group "${to}" already exists`)
  return listAccountGroups(at)
}

/** The group and its memberships go; its accounts stay, in their other groups and in `all`. */
export const deleteAccountGroup = async (at: GroupStore, group: string): Promise<GroupMembership> => {
  unlocked(at)
  await at.store.accounts.saveAccountGroup(await savedGroup(at, group), undefined)
  return listAccountGroups(at)
}

/**
 * The owner's choice of which side of his life an account is on, as the store now holds it. Moving an account to work
 * lets work views and meeting preparation read it, so a command over this is the owner's alone (`grantsAuthority`).
 */
export const setAccountScope = async (at: GroupStore, change: AccountScopeChange): Promise<StoredAccount> => {
  unlocked(at)
  const scope = scopeOf(change.scope)
  const { provider, account } = accountOf(await contextOf(at), change.member)
  return at.store.accounts.setScope({ provider, account }, scope)
}

/** The owner pins one chat to a scope, or with `null` lets it follow its account; the owner's alone, as above. */
export const setChatScope = async (at: GroupStore, change: ChatScopeChange): Promise<ChatScope> => {
  unlocked(at)
  const scope = change.scope === null ? null : scopeOf(change.scope)
  const { provider, account } = accountOf(await contextOf(at), change.member)
  const key = { provider, account }
  if (!(await at.store.chats.setChatScope(key, change.chat, scope)))
    fail("not_found", `no chat ${change.chat} stored in ${sourceOf(key)}`)
  const effective = (await at.store.chats.chatScopes(key, [change.chat])).get(change.chat) ?? "personal"
  return { ...key, chat: change.chat, own: scope, scope: effective }
}
