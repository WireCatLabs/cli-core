import { type QueryAst, queryError } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import type * as v from "valibot"
import type {
  Account,
  AccountSession,
  Chat,
  ChatCard,
  ChatEvent,
  Contact,
  Folder,
  GroupCard,
  GroupMember,
  InviteLink,
  JoinRequest,
  Member,
  PersonCard,
  PersonProfile,
  PollVote,
  Topic,
} from "../../domain/models.js"
import { formatReference } from "../../domain/references.js"
import type {
  account as accountSchema,
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
import type { ChatDocument } from "../../services/chat-documents.js"
import type { FolderShown } from "../../services/folders.js"
import type { MemberEvent } from "../../services/member-history.js"
import { AUDIT_MIN_SCORE, type AuditedMember, type MembersAudit } from "../../services/members-audit.js"
import type { AccountKey } from "../../store/store.js"
import { type AnswerOutput, itemOf, type ListInput, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { LIST_QUERY_GUIDE, nativeTerms } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { nextStep } from "../steps.js"

type Out<T extends v.GenericSchema> = v.InferOutput<T>

const defined = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T

export const chatRef = (account: AccountKey, chat: string): string =>
  formatReference({ type: "chat", provider: account.provider, account: account.account, chat })

const settingsOf = (settings: GroupCard["settings"]) =>
  defined({
    all_can_pin: settings.allCanPin,
    only_admins_add: settings.onlyAdminsAdd,
    only_admins_call: settings.onlyAdminsCall,
    only_owner_edits_info: settings.onlyOwnerEditsInfo,
    members_see_link: settings.membersSeeLink,
    join_approval: settings.joinApproval,
    only_admins_send: settings.onlyAdminsSend,
    only_admins_edit_info: settings.onlyAdminsEditInfo,
    disappearing_seconds: settings.disappearingSeconds,
  })

type ShownChat = Chat &
  Partial<Pick<ChatCard, "members">> & {
    description?: string | null
    link?: string | null
    settings?: GroupCard["settings"]
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
    muted_until: chat.mutedUntil ?? undefined,
    archived: chat.archived,
    marked_unread: chat.markedUnread,
    membership_state: chat.membershipState,
    parent_chat_id: chat.parentChatId ?? undefined,
    scope: chat.scope,
    provider_metadata: chat.providerMetadata,
    description: chat.description,
    invite_link: chat.link,
    settings: chat.settings ? settingsOf(chat.settings) : undefined,
    members: chat.members?.map(memberAnswer),
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

/**
 * `contacts show`: the card (the owner's alias and notes, the chats shared) with what the messenger says about the
 * person, and in each shared chat how much of their writing the store holds.
 */
export const contactShown = (
  account: AccountKey,
  card: PersonCard,
  profile: PersonProfile,
): Out<typeof contactSchema> => {
  const { id: _id, name: _name, bio, chats, ...facts } = profile
  const listed = new Map(card.chats.map((chat) => [chat.id, chat]))
  const active = new Set(chats.map(({ id }) => id))
  const shared = [
    ...chats.map((chat) => ({
      ref: chatRef(account, chat.id),
      id: chat.id,
      title: chat.title,
      kind: chat.kind,
      last_message_at: listed.get(chat.id)?.lastMessageAt ?? chat.lastAt,
      their_messages: chat.theirMessages,
      first_at: chat.firstAt,
      last_at: chat.lastAt,
      complete: chat.complete,
    })),
    ...card.chats
      .filter(({ id }) => !active.has(id))
      .map((chat) => ({
        ref: chatRef(account, chat.id),
        id: chat.id,
        title: chat.title,
        kind: chat.kind,
        last_message_at: chat.lastMessageAt,
      })),
  ]
  const answer = contactAnswer(account, card)
  return {
    ...answer,
    ...(snakeKeys(facts) as object),
    description: answer.description ?? bio,
    chats: shared,
  } as Out<typeof contactSchema>
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
    untrusted: ["title"],
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

/** The lowest score `score>=n` asks for; the audit's own floor when the query names none. */
export const scoreFloor = (ast: QueryAst | undefined): number => {
  const term = nativeTerms(ast, "chats members check").get("score")
  if (!term) return AUDIT_MIN_SCORE
  const upper = term.operator === "range" ? (term.upper ?? "*") : term.value
  if (term.operator !== "range" || upper !== "*")
    queryError("query.unsupported-operator", term.span, "score takes a lower bound: score>=3", {
      command: "chats members check",
      guide: LIST_QUERY_GUIDE,
    })
  const floor = Number(term.value)
  return Math.ceil(term.lower_inclusive === false ? floor + 1 : floor)
}

export const auditAnswer = (audit: MembersAudit) =>
  wholeList("chats members check", audit.items.map(memberAnswer), {
    ...(audit.more ? { meta: { truncated: true } } : {}),
    ...(audit.completeness && audit.completeness.state !== "complete"
      ? {
          missing: [
            {
              field: "reasons",
              why: "never_wrote counts only stored messages, and the store does not hold the chat whole",
              ...(audit.fetch ? { step: "messages.sync" } : {}),
            },
          ],
          ...(audit.fetch ? { next: [nextStep("messages.sync", { args: { chat: audit.chatId } })] } : {}),
        }
      : {}),
  })

/** An answer with no entity yet: the item as it is, its keys in snake_case. */
export const renderItem = (command: Command, output: AnswerOutput, value: unknown, next: NextStep[] = []): void =>
  renderAnswer(command, output, itemOf(snakeKeys(value), { next }))

/**
 * `--limit` and `--page` for a list whose source takes a count but no offset: page n reads n pages and shows
 * the last, so the step to the next page is honest.
 */
export const withPage = (command: Command): Command =>
  command
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))

export const pageOfRead = ({ hasMore }: { hasMore: boolean }, limit: number, page: number) => ({
  limit,
  has_more: hasMore,
  page,
})

/** A document link in a chat's stored messages; `ref` is the message's locator. */
export const documentLinkAnswer = ({ url, documentId, title, inStore, locator, sentAt, sender }: ChatDocument) => ({
  url,
  document_id: documentId,
  title,
  in_store: inStore,
  ref: locator,
  sent_at: sentAt,
  sender,
})

/** The account as `account show` answers it: what the messenger said, under the provider that said it. */
export const accountAnswer = (provider: string, { id, name, username, phone }: Account): Out<typeof accountSchema> => ({
  provider,
  id,
  name,
  username,
  ...(phone === undefined ? {} : { phone }),
})

/** Somewhere else the account is logged in, as `account sessions list` answers it. */
export const sessionAnswer = ({ current, client, device, location, lastActiveAt, createdAt }: AccountSession) => ({
  current,
  client,
  device,
  location,
  last_active_at: lastActiveAt,
  ...(createdAt === undefined ? {} : { created_at: createdAt }),
})
