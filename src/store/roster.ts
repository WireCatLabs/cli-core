import { CliError } from "@wirecat/cli-base"
import type { ChatEvent, Id, Member } from "../domain/models.js"
import type { RetentionOptions } from "../domain/retention.js"
import { keysOver } from "./keys.js"
import { chatEventsOf, saveChatEvents } from "./sqlite/chat-events.js"
import * as chatQueries from "./sqlite/chats.js"
import type { StoreContext } from "./sqlite/open.js"
import { type RetentionResult, retentionQuery } from "./sqlite/retention.js"
import type {
  MemberCount,
  MemberStay,
  ProfileRevision,
  RosterChange,
  RosterRead,
  TrackedChat,
} from "./sqlite/roster.js"
import * as roster from "./sqlite/roster.js"
import { read, write } from "./sqlite/transaction.js"
import type { AccountKey } from "./types.js"

export interface RosterStore {
  /** Replaces who is in a chat with this list, whole: a person left out has left. */
  saveMembers(key: AccountKey, chatId: Id, memberIds: Id[]): Promise<void>
  /** Who is in a chat, by name, as the last list said; empty when no list was ever saved. */
  members(key: AccountKey, chatId: Id): Promise<Member[]>
  /**
   * One read of a group's member list: stays opened and kept, a stay closed only when the read was whole,
   * profiles revised when they differ, today's count. The chat's present members become the list read whole.
   */
  saveRoster(key: AccountKey, chatId: Id, read: RosterRead): Promise<RosterChange>
  /** Stays open at `since` (ISO) or begun after it, oldest first; every stay without it. */
  memberStays(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<MemberStay[]>
  /** One row a day, oldest first; from `since` (`YYYY-MM-DD`) when given. */
  memberCounts(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<MemberCount[]>
  /** Every profile the chat's members were seen with, oldest first. */
  profileRevisions(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<ProfileRevision[]>
  /** Who joined, left, was added, removed, promoted or demoted, as the messenger reported it; a replay changes nothing. */
  saveChatEvents(key: AccountKey, chatId: Id, events: ChatEvent[]): Promise<void>
  /** Oldest first, from `since` (ISO); only the newest `limit` when there are more. */
  chatEvents(key: AccountKey, chatId: Id, options?: { since?: string; limit?: number }): Promise<ChatEvent[]>
  /** Starts or stops `serve`'s daily fetch of the chat's members; history already kept stays. */
  trackMembers(key: AccountKey, chatId: Id, tracked: boolean): Promise<void>
  trackedChats(key: AccountKey): Promise<TrackedChat[]>
  retention(
    key: AccountKey,
    chatId: Id,
    options: RetentionOptions,
    evidence?: { cohort: string; cursor?: string },
  ): Promise<RetentionResult>
}

export const rosterStoreOver = (context: StoreContext): RosterStore => {
  const { database } = context
  const { accountPk, findAccountPk, chatKeyOf, chatPkFor, writeMembers } = keysOver(context)
  return {
    saveMembers: async (key, chatId, memberIds) =>
      write(database, () => writeMembers(key, accountPk(key), chatId, memberIds)),

    members: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : chatQueries.members(context, chatKey)
    },

    saveRoster: async (key, chatId, read) => {
      let change: RosterChange = { joined: [], gone: [], changed: [] }
      write(database, () => {
        const accountKey = accountPk(key)
        change = roster.saveRoster(context, accountKey, key.provider, chatPkFor(accountKey, chatId), read)
      })
      return change
    },

    memberStays: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : roster.memberStaysOf(context, chatKey, since === undefined ? undefined : Date.parse(since))
    },

    memberCounts: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : roster.memberCountsOf(context, chatKey, since)
    },

    profileRevisions: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : roster.profileRevisionsOf(context, chatKey, since === undefined ? undefined : Date.parse(since))
    },

    saveChatEvents: async (key, chatId, events) =>
      write(database, () => {
        const accountKey = accountPk(key)
        saveChatEvents(context, accountKey, key.provider, chatPkFor(accountKey, chatId), events)
      }),

    chatEvents: async (key, chatId, { since, limit } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : read(database, () =>
            chatEventsOf(context, chatKey, {
              ...(since === undefined ? {} : { since: Date.parse(since) }),
              ...(limit === undefined ? {} : { limit }),
            }),
          )
    },

    trackMembers: async (key, chatId, tracked) =>
      write(database, () => roster.setTracked(context, chatPkFor(accountPk(key), chatId), tracked)),

    trackedChats: async (key) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : roster.trackedChats(context, accountKey)
    },

    retention: async (key, chatId, options, evidence) => {
      const accountKey = findAccountPk(key)
      const chatKey = chatKeyOf(key, chatId)
      if (accountKey === undefined || chatKey === undefined)
        throw new CliError("validation_error", "retention needs a stored chat and membership observations")
      return read(database, () => retentionQuery(context, accountKey, chatKey, chatId, options, evidence))
    },
  }
}
