import type { ChannelTagMatch } from "../../domain/channel-tags.js"
import type { Chat, Id, Member, Page } from "../../domain/models.js"
import type { ChatMetadata } from "./chats-types.js"
import type { ChatCompleteness } from "./completeness-types.js"
import type { AccountKey, ChatActivity, ChatStats, StoredChatFilter } from "./models.js"
import type { MemberCount, MemberStay, ProfileRevision, RosterChange, RosterRead, TrackedChat } from "./roster-types.js"

export interface ChatsStore {
  saveChats(key: AccountKey, chats: Chat[]): Promise<void>

  /** Newest first. `query` matches three letters or more of a title; `unread` keeps chats with unread messages. */
  chats(key: AccountKey, window: { limit?: number; offset?: number } & StoredChatFilter): Promise<Page<Chat>>

  countChats(key: AccountKey, filter?: StoredChatFilter): Promise<number>

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

  /** Starts or stops `serve`'s daily fetch of the chat's members; history already kept stays. */
  trackMembers(key: AccountKey, chatId: Id, tracked: boolean): Promise<void>

  trackedChats(key: AccountKey): Promise<TrackedChat[]>

  /** The chats a person is in, newest first — as far as the saved member lists go. */
  chatsWith(key: AccountKey, memberId: Id): Promise<Chat[]>

  /**
   * Given every chat the account is in, marks the rest `left` and says how many it marked. Only
   * ever from a complete list: a page or a cut list says nothing about the chats it leaves out.
   * Remembers when, so a search can say the store knows the account's whole chat list.
   */
  markChatsLeft(key: AccountKey, present: Id[]): Promise<number>

  /** The chats marked left and the messages they hold; with `clear`, deletes them and all under them. */
  leftChats(key: AccountKey, options?: { clear?: boolean }): Promise<{ chats: number; messages: number }>

  /** Per chat: whether its history is held up to date, without gaps, back to its start. */
  chatCompleteness(key: AccountKey, chatIds: Id[]): Promise<ChatCompleteness[]>

  /** Per chat that has messages: how many, the oldest and newest, and when the last one was stored. */
  chatStats(key: AccountKey, chatId?: Id): Promise<ChatStats[]>

  /** Per chat that spoke since `since` (ms): its newest message and who sent it when stored, never the text. */
  chatActivity(key: AccountKey, since: number): Promise<{ chats: ChatActivity[]; storedAt: string | null }>

  /** Labels one stored chat, person or message; answers the tags it did not have. `not_found` for one not held. */
  chatMetadata(key: AccountKey, chatId: Id): Promise<ChatMetadata | undefined>

  saveChatMetadata(key: AccountKey, entry: Omit<ChatMetadata, "fetchedAt">): Promise<ChatMetadata>

  replaceAutoTags(key: AccountKey, chatId: Id, algorithm: string, tags: ChannelTagMatch[]): Promise<void>
}
