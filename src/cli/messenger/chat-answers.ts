import type * as v from "valibot"
import type {
  Chat,
  ChatCard,
  ChatEvent,
  Contact,
  Folder,
  GroupMember,
  GroupSettings,
  InviteLink,
  JoinRequest,
  Member,
  PersonCard,
  PollVote,
  Topic,
} from "../../domain/models.js"
import { formatReference } from "../../domain/references.js"
import type {
  chatEvent as chatEventSchema,
  chat as chatSchema,
  contact as contactSchema,
  folder as folderSchema,
  inviteLink as inviteLinkSchema,
  joinRequest as joinRequestSchema,
  member as memberSchema,
  pollVote as pollVoteSchema,
  topic as topicSchema,
} from "../../entities/index.js"
import type { FolderShown } from "../../services/folders.js"
import type { MemberEvent } from "../../services/member-history.js"
import type { AuditedMember } from "../../services/members-audit.js"
import type { AccountKey } from "../../store/store.js"
import { itemOf, type ListInput, listOf } from "../envelope.js"
import { nextStep } from "../steps.js"

type Out<T extends v.GenericSchema> = v.InferOutput<T>

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/**
 * An answer that has no entity yet — a write's receipt, a count — with snake_case keys, nested ones too.
 * Only for records whose keys are field names, never for one keyed by data.
 */
export const snakeKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(snakeKeys)
  if (value === null || typeof value !== "object" || value.constructor !== Object) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inner]) => (inner === undefined ? [] : [[snake(key), snakeKeys(inner)]])),
  )
}

const defined = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T

export const chatRef = (account: AccountKey, chat: string): string =>
  formatReference({ type: "chat", provider: account.provider, account: account.account, chat })

const settingsOf = (settings: GroupSettings) =>
  defined({
    all_can_pin: settings.allCanPin,
    only_admins_add: settings.onlyAdminsAdd,
    only_admins_call: settings.onlyAdminsCall,
    only_owner_edits_info: settings.onlyOwnerEditsInfo,
    members_see_link: settings.membersSeeLink,
    join_approval: settings.joinApproval,
  })

type ShownChat = Chat &
  Partial<Pick<ChatCard, "members">> & {
    description?: string | null
    link?: string | null
    settings?: GroupSettings
  }

export const chatAnswer = (account: AccountKey, chat: ShownChat): Out<typeof chatSchema> =>
  defined({
    ref: chatRef(account, chat.id),
    id: chat.id,
    title: chat.title,
    kind: chat.kind,
    unread_count: chat.unreadCount,
    unread_mentions: chat.unreadMentions,
    last_message_at: chat.lastMessageAt,
    participants_count: chat.participantsCount,
    muted: chat.muted,
    archived: chat.archived,
    membership_state: chat.membershipState,
    parent_chat_id: chat.parentChatId,
    scope: chat.scope,
    provider_metadata: chat.providerMetadata,
    description: chat.description,
    invite_link: chat.link,
    settings: chat.settings ? settingsOf(chat.settings) : undefined,
    members: chat.members === undefined ? undefined : (chat.members?.map(memberAnswer) ?? null),
  })

export const memberAnswer = (member: Member | GroupMember | AuditedMember): Out<typeof memberSchema> => {
  const group = member as GroupMember & Partial<AuditedMember>
  return defined({
    id: member.id,
    name: member.name,
    username: member.username,
    role: group.role,
    last_seen_at: group.lastSeenAt,
    registered_at: group.registeredAt,
    joined_at: group.joinedAt,
    invited_by: group.invitedBy,
    is_bot: group.isBot,
    deleted: group.deleted,
    flagged: group.flagged,
    has_photo: group.hasPhoto,
    score: group.score,
    reasons: group.reasons,
    check: group.check ? (snakeKeys(group.check) as Record<string, unknown>) : undefined,
  })
}

export const contactRef = (provider: string, id: string): string => formatReference({ type: "contact", provider, id })

export const contactAnswer = (account: AccountKey, contact: Contact | PersonCard): Out<typeof contactSchema> => {
  const card = contact as Partial<PersonCard>
  return defined({
    ref: contactRef(account.provider, contact.id),
    id: contact.id,
    name: contact.name,
    username: contact.username,
    alias: contact.alias,
    display_name: contact.displayName,
    description: contact.description,
    last_messaged_at: contact.lastMessagedAt,
    chats: card.chats?.map((chat) => ({
      ref: chatRef(account, chat.id),
      id: chat.id,
      title: chat.title,
      kind: chat.kind,
      last_message_at: chat.lastMessageAt,
    })),
    notes: card.notes?.map(({ id, text, revision, createdAt, updatedAt }) => ({
      id,
      text,
      revision,
      created_at: createdAt,
      updated_at: updatedAt,
    })),
  })
}

export const chatEventAnswer = (chatId: string, event: ChatEvent): Out<typeof chatEventSchema> =>
  defined({
    chat_id: chatId,
    time: event.timestamp,
    type: event.event,
    message_id: event.messageId,
    by: event.by,
    people: event.people,
    title: event.title,
  })

const HISTORY_TYPES = { joined: "join", left: "leave", changed: "profile" } as const

export const memberEventAnswer = (chatId: string, event: MemberEvent): Out<typeof chatEventSchema> =>
  defined({
    chat_id: chatId,
    time: event.at,
    type: HISTORY_TYPES[event.event],
    by: event.invitedBy === undefined ? undefined : { id: event.invitedBy, name: null },
    people: [{ id: event.id, name: event.name, username: event.username }],
    before: event.before ? { name: event.before.name, username: event.before.username } : undefined,
  })

export const inviteLinkAnswer = (link: InviteLink): Out<typeof inviteLinkSchema> =>
  defined({
    link: link.link,
    approval: link.approval,
    expires_at: link.expiresAt,
    max_uses: link.maxUses,
    primary: link.primary,
    revoked: link.revoked,
    pending_count: link.pending,
    joined_count: link.joined,
  })

export const joinRequestAnswer = (request: JoinRequest): Out<typeof joinRequestSchema> =>
  defined({
    person_id: request.person.id,
    name: request.person.name,
    username: request.person.username,
    requested_at: request.requestedAt,
    about: request.about,
  })

export const pollVoteAnswer = (vote: PollVote): Out<typeof pollVoteSchema> => ({
  person_id: vote.person.id,
  name: vote.person.name,
  username: vote.person.username,
  answers: vote.answers,
  voted_at: vote.votedAt,
})

export const topicAnswer = (topic: Topic): Out<typeof topicSchema> =>
  defined({
    id: topic.id,
    title: topic.title,
    closed: topic.closed,
    pinned: topic.pinned,
    hidden: topic.hidden,
    unread_count: topic.unreadCount,
    last_message_at: topic.lastMessageAt,
    created_at: topic.createdAt,
  })

export const folderAnswer = (folder: Folder | FolderShown): Out<typeof folderSchema> => {
  const shown = "chats" in folder ? folder : undefined
  const listed = shown ? undefined : (folder as Folder)
  return defined({
    id: folder.id,
    title: folder.title,
    chat_ids: listed ? listed.chatIds : (shown?.chats.map((chat) => chat.id) ?? []),
    emoji: folder.emoji,
    include: folder.include,
    skip: folder.skip,
    excluded_chat_ids: listed?.excludedChatIds ?? shown?.excluded.map((chat) => chat.id),
    pinned_chat_ids: listed?.pinnedChatIds ?? shown?.pinned.map((chat) => chat.id),
    chats: shown?.chats,
    pinned_chats: shown?.pinned,
    excluded_chats: shown?.excluded,
  })
}

/** A person's view of a list: one line per item. */
export const lines =
  <T>(line: (item: T) => string) =>
  (body: { items?: T[]; item?: T }): string =>
    (body.items ?? (body.item === undefined ? [] : [body.item])).map((item) => `${line(item).trimEnd()}\n`).join("")

/** `limit` and `page` of a list paged by `--page`; `--all` is one page holding everything. */
export const pageOf = (
  { limit, page, all }: { limit: number; page: number; all?: boolean },
  { items, hasMore }: { items: readonly unknown[]; hasMore: boolean },
) => (all ? { limit: Math.max(1, items.length), has_more: false, page: 1 } : { limit, has_more: hasMore, page })

/** A list read whole, in one page. */
export const wholeList = <T>(
  command: string,
  items: T[],
  extra: Pick<ListInput<T>, "next" | "missing" | "meta"> = {},
) => listOf(command, { items, limit: Math.max(1, items.length), has_more: false, ...extra })

/** `chats show`: the chat, and where its member list is shorter than its own count, the command that lists them all. */
export const chatShown = (account: AccountKey, card: Parameters<typeof chatAnswer>[1]) => {
  const listed = card.members?.length
  const short = listed !== undefined && card.participantsCount !== null && listed < card.participantsCount
  return itemOf(
    chatAnswer(account, card),
    short
      ? {
          missing: [
            {
              field: "members",
              why: `${listed} listed; the chat reports ${card.participantsCount} — the list may omit your account or be partial`,
              step: "chats.members",
            },
          ],
          next: [nextStep("chats.members", { args: { chat: card.id } })],
        }
      : {},
  )
}
