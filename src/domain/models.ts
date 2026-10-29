import type { Upload } from "./attachments.js"
import type { CounterObservation, CounterObservations } from "./counters.js"

/**
 * What every messenger CLI built on this package promises. **Raw provider objects never reach
 * output**: wire shapes change without notice and carry fields whose meaning nobody knows. An
 * adapter translates into these types; everything above it speaks only them.
 *
 * A field is here only when more than one messenger has it. What only one provider has travels in
 * `providerMetadata`, so a shared type never grows a field that means nothing elsewhere.
 */

/** Every id is a string, never a number: provider ids are 64-bit, and an id is not arithmetic. */
export type Id = string

/** `telegram`, `max`… Open, because a new adapter must not need a change here. */
export type Provider = string

/** Whatever one provider knows that the shared model has no field for. */
export type ProviderMetadata = Record<string, unknown>

/** `saved` is the account's notes-to-self chat. */
export type ChatKind = "dialog" | "group" | "channel" | "saved" | "unknown"

/** Where the owner stands in a chat. Kept apart from whether its messages are searchable: a chat left keeps them. */
export type MembershipState = "joined" | "left" | "public" | "imported" | "archived" | "external"

export interface Chat {
  /** Saving a chat: absent keeps the stored parent, `null` clears it. */
  parentChatId?: Id | null
  scope?: "personal" | "work"
  id: Id
  title: string | null
  kind: ChatKind
  /**
   * `null` means the provider did not say, which is not the same as zero. A save that does not know it leaves it
   * out.
   */
  unreadCount: number | null
  /** ISO 8601, or `null` when the chat has never had a message. */
  lastMessageAt: string | null
  participantsCount: number | null
  /** Absent where the messenger does not say. A mute that has ended reads as `false`. */
  muted?: boolean
  /**
   * ISO 8601 UTC: when the mute ends. `null` or absent with `muted` is for good. Saving a chat: absent keeps the stored
   * end, and `muted: false` clears it.
   */
  mutedUntil?: string | null
  archived?: boolean
  /** The owner marked the chat unread, whatever its count; absent where the messenger does not say. */
  markedUnread?: boolean
  /** Unread messages that mention the owner or reply to them. */
  unreadMentions?: number
  /** Absent where the messenger does not say. */
  membershipState?: MembershipState
  /**
   * Saving a chat merges this into the stored one key by key: a key left out keeps its stored value, a key set to
   * `null` is removed. So a key that is gone, or a flag that turned false, is sent as `null`.
   */
  providerMetadata?: ProviderMetadata
}

/**
 * A chat as an adapter saves it. A `title`, `unreadCount`, `lastMessageAt`, `participantsCount` or `membershipState`
 * left out keeps the stored value; `null` stores none. So a push that knows only some of them, such as a notice that
 * a group left its community, leaves the rest out. `membershipState: "member"` says the owner is in the chat again: it
 * takes off a "left" mark and keeps any other state, such as "archived". It is never stored. `muted`, `mutedUntil`,
 * `archived` and `markedUnread` left out keep the stored value too.
 */
export type ChatUpdate = Omit<Chat, KeptFields | "membershipState"> &
  Partial<Pick<Chat, KeptFields>> & { membershipState?: MembershipState | "member" | null }
type KeptFields = "title" | "unreadCount" | "lastMessageAt" | "participantsCount"

/** A group's switches; `null` where the messenger does not say, or has no such switch. */
export interface GroupSettings {
  allCanPin: boolean | null
  onlyAdminsAdd: boolean | null
  onlyAdminsCall: boolean | null
  onlyOwnerEditsInfo: boolean | null
  membersSeeLink: boolean | null
  /** People ask to join and an admin lets them in. Only where the messenger lists it in `groupSettings`. */
  joinApproval?: boolean | null
}

/**
 * Switches only some messengers have, each only where the messenger lists it in `groupSettings`. Kept out of
 * `GroupSettings` so that a table keyed on its keys — max-cli's flag names — does not have to name these.
 */
export interface MoreGroupSettings {
  /** Only admins send messages. */
  onlyAdminsSend?: boolean | null
  /** Only admins change the name, photo and description — every admin, where `onlyOwnerEditsInfo` is the owner alone. */
  onlyAdminsEditInfo?: boolean | null
  /** New messages disappear this many seconds after sending; 0 keeps them. */
  disappearingSeconds?: number | null
}

/** Every switch `chats update` knows. */
export type GroupSettingKey = keyof GroupSettings | keyof MoreGroupSettings

/** What `chats update` changes; a field left out stays as it is. */
export interface GroupChange {
  title?: string
  description?: string
  settings?: Partial<GroupSettings> & MoreGroupSettings
  photo?: Upload
  /** Takes the group's photo away; never beside `photo`. Only where `Messenger.groupPhotoRemoval` is on. */
  removePhoto?: true
}

export const GROUP_SETTINGS = [
  "allCanPin",
  "onlyAdminsAdd",
  "onlyAdminsCall",
  "onlyOwnerEditsInfo",
  "membersSeeLink",
] as const

/** One line of `contacts import`: a phone number as digits, and the name to save it under. */
export interface PhoneBookEntry {
  phone: string
  name: string
}

/** A chat folder. */
export interface Folder {
  id: string
  title: string
  /** Chats added to it by hand; a folder that selects chats by a rule of its own lists none. */
  chatIds: Id[]
  emoji?: string
  /** Kinds of chat it takes by itself, beside `chatIds`. */
  include?: FolderKind[]
  /** Chats it leaves out even when a kind takes them. */
  skip?: FolderSkip[]
  excludedChatIds?: Id[]
  pinnedChatIds?: Id[]
}

export const FOLDER_KINDS = ["contacts", "non-contacts", "groups", "channels", "bots"] as const
export type FolderKind = (typeof FOLDER_KINDS)[number]
export const FOLDER_SKIPS = ["muted", "read", "archived"] as const
export type FolderSkip = (typeof FOLDER_SKIPS)[number]

/** A folder's rules beside its chats; `include` and `skip` replace what it had, the chat lists add to it. */
export interface FolderRules {
  emoji?: string
  include?: FolderKind[]
  skip?: FolderSkip[]
  exclude?: Id[]
  pin?: Id[]
}

/** What `chats folders update` changes; chats by id. `remove` takes a chat off every list it is on. */
export interface FolderChange extends FolderRules {
  title?: string
  add?: Id[]
  remove?: Id[]
}

/** What an admin may do, in max-cli's words; a messenger maps them onto its own. */
export const ADMIN_RIGHTS = ["read", "members", "admins", "info", "pin", "link", "post", "edit", "delete"] as const

export type AdminRight = (typeof ADMIN_RIGHTS)[number]

/** An additional invite link; the group's own link is `GroupCard.link`. */
export interface InviteLink {
  link: string
  /** Who joins by it asks first, and an admin lets them in. */
  approval: boolean
  /** ISO 8601; `null` when it never expires. */
  expiresAt: string | null
  /** How many people may join by it; `null` for no limit. */
  maxUses: number | null
  /** The group's own link; revoking it makes the messenger issue a new one. */
  primary?: boolean
  revoked?: boolean
  /** Requests by it waiting for an answer. */
  pending?: number
  /** People who joined by it. */
  joined?: number
}

/** What `chats links update` changes; a field left out stays as it is. */
export interface InviteLinkChange {
  approval?: boolean
  /** ISO 8601; `null` makes it never expire. */
  expiresAt?: string | null
  maxUses?: number
}

/** A group or channel as the commands that change one answer it. */
export interface GroupCard extends Chat {
  description: string | null
  /** The invite link; only a member who may see it gets one. */
  link: string | null
  settings: GroupSettings & MoreGroupSettings
}

export interface Attachment {
  /** Lower-cased: `photo`, `video`, `file`, `voice`, `sticker`, `share`… */
  kind: string
  /** A link that opens the bytes or the shared page, when the provider hands one out. */
  url?: string
  width?: number
  height?: number
  /** A shared page's title. */
  title?: string
  name?: string
  size?: number
  mime?: string
  /** Seconds, for audio and video. */
  duration?: number
  /** What the adapter needs to fetch the bytes later. Opaque above the adapter. */
  providerRef?: ProviderMetadata
  /** A bot's keyboard under the message, row by row. */
  buttons?: Button[][]
  /** The poll the message carries, as it stood when read; drawn for a person, not part of the JSON answer. */
  poll?: Poll
  /** The contact card shared in the message (`kind: "contact"`), the phone as the sender typed it. */
  contact?: SharedContact
}

/** A contact card sent in a message: who it is for, and the number the sender put on it. */
export interface SharedContact {
  /** First and last name as shown. */
  name: string
  firstName?: string
  lastName?: string
  phone?: string
  /** The messenger's account for the card, when the number belongs to one. */
  userId?: Id
}

/**
 * What pressing a bot's button does: `callback` tells the bot, `link` opens `url`, `message` sends its
 * text, `chat` opens a chat, `contact` and `location` hand the owner's phone or place to the bot, `app`
 * opens the bot's mini app, `clipboard` copies.
 */
export type ButtonKind =
  | "callback"
  | "link"
  | "message"
  | "chat"
  | "contact"
  | "location"
  | "app"
  | "clipboard"
  | "other"

/** One button of a bot's keyboard. What the bot gets on a press stays inside the adapter. */
export interface Button {
  kind: ButtonKind
  text: string
  url?: string
}

/** Where one attachment's bytes can be fetched. */
export interface AttachmentLink {
  kind: string
  url: string
  name?: string
  /** The provider flags the file as possibly harmful. */
  unsafe?: boolean
}

/** What a chat has pinned after `messages pin` or `unpin`; `null` is nothing. */
export interface Pin {
  chatId: Id
  pinned: Id | null
}

/** What `messages delete` asked the provider to remove, and for whom. */
export interface Deletion {
  chatId: Id
  deleted: Id[]
  forEveryone: boolean
}

/** One answer of a poll. `id` is the provider's own, not a position: a vote names it. */
export interface PollAnswer {
  id: Id
  text: string
  /** `null` until the owner has voted or the poll is closed — the provider does not say before. */
  voters: number | null
  chosen: boolean
}

/** A poll as the message that carries it has it now. */
export interface Poll {
  chatId: Id
  messageId: Id
  question: string
  answers: PollAnswer[]
  closed: boolean
  multiple: boolean
  /** Nobody sees who voted for what. */
  anonymous: boolean
  voters: number | null
  /** Has one correct answer. Absent where the messenger does not say. */
  quiz?: boolean
  /** A voter may change or retract their vote. */
  revote?: boolean
  /** This account made it, so only it may close it. */
  creator?: boolean
}

/** One person's vote in a poll that is not anonymous. */
export interface PollVote {
  person: Member
  /** Answer ids, as `Poll.answers` has them. */
  answers: Id[]
  /** ISO 8601. */
  votedAt: string
}

/** A chat marked read up to `messageId`, inclusive. `unread` is what the provider says is left, or `null`. */
export interface ReadMark {
  chatId: Id
  messageId: Id
  unread: number | null
}

/** The reactions on one message, as the provider counts them. */
export interface Reactions {
  counts: { reaction: string; count: number }[]
  /** This account's own reaction, or `null`. */
  mine: string | null
  total: number
}

/**
 * One person's reaction to a message, for a messenger that sends a reaction change at a time (WhatsApp) instead of
 * totals. `reaction` is `null` when they took it back. The store keeps each person's newest by `reactedAt` and derives
 * the message's `Reactions` from them.
 */
export interface PersonReaction {
  person: Member
  /** The owner's own reaction, which becomes `Reactions.mine`. */
  own: boolean
  reaction: string | null
  /** ISO 8601 — when the person reacted, as the messenger says, not when it arrived. */
  reactedAt: string
}

/** One person's reaction to a message, as `reactions list` gives it. */
export interface Reactor {
  person: Member
  reaction: string
  /** ISO 8601. */
  reactedAt: string
}

/** The message a reply answers or a forward carries. */
export interface QuotedMessage {
  id: Id
  senderId: Id | null
  senderName: string | null
  /** ISO 8601, or `null` when the quote did not say. */
  timestamp: string | null
  text: string
  attachments: Attachment[]
  /** Whether this account wrote it. `null` when we do not know who we are. */
  outgoing: boolean | null
}

export interface Message {
  id: Id
  chatId: Id
  senderId: Id | null
  senderName: string | null
  /** The sender's handle without `@`, where the messenger has one: what people type to mention them. */
  senderUsername?: string
  /** People the text mentions by id, where the messenger marks them — a mention by name, with no `@handle`. */
  mentions?: Id[]
  /** `senderId` is a chat, not a person — a channel post, or a message sent as the group. */
  senderIsChat?: boolean
  /** ISO 8601. */
  timestamp: string
  /**
   * When the provider last recorded an edit, or `null` for a message nobody has changed. Surfaced
   * because a reader has no other way to tell an edited message from the original, and because it
   * is what a store compares to decide whether its copy is still current.
   */
  editedAt: string | null
  text: string
  /** Whether this account sent it. `null` when we do not know who we are. */
  outgoing: boolean | null
  attachments: Attachment[]
  replyTo: QuotedMessage | null
  /**
   * The id a reply answers, also when the provider sent no copy of that message — Telegram sends
   * only the id, MAX the whole message. Reply chains are what research needs most.
   */
  replyToId?: Id
  forwardedFrom: QuotedMessage | null
  /** The topic or thread inside the chat, where the provider has them. */
  threadId?: Id
  threadRootId?: Id
  /** `null` when nobody asked — offline, or the request failed. */
  reactions: Reactions | null
  counterObservations?: CounterObservations
  /** ISO 8601 — when the provider will send it. Present only on a message still waiting in the queue. */
  scheduledFor?: string
  providerMetadata?: ProviderMetadata
  /**
   * The owner's star, where the messenger has stars (`messageStars`). Read back only when set. On a save, absent
   * keeps what the store holds: a fetch, an edit or another messenger's message says nothing about it.
   */
  starred?: boolean
  /**
   * How far the owner's own message got in a one-to-one chat, from the messenger's receipts: `read` once the other
   * person opened it. Absent when no receipt came. On a save, absent keeps what the store holds, and a state never
   * moves back: a late `delivered` after `read` changes nothing.
   */
  delivery?: Delivery
}

/** MAX reports the owner's own messages with no sender id, so `outgoing` counts as well as the id. */
export const senderIsMe = (message: Pick<Message, "outgoing" | "senderId">, account: string): boolean =>
  message.outgoing === true || (message.senderId !== null && String(message.senderId) === account)

/** `delivered` reached the other person's phone; `read` they opened it (a voice note or view-once file played counts). */
export type Delivery = "delivered" | "read"

/**
 * A message found by searching, carrying the chat's name as well as its id: a search spans every
 * chat, so an answer that named only the id would make the reader look each one up.
 */
export interface MessageHit extends Message {
  chatTitle: string | null
  /** Set on an email: who it was between, its labels and its thread, as references other commands take. */
  email?: MailFields
  /** A short stretch of `text` around what matched; the output shows it instead of the whole text unless asked. */
  excerpt?: string
}

/** Someone on an email; `ref` is their `person:` reference, `null` when the store has none. */
export interface MailPerson {
  name: string | null
  address: string
  ref: string | null
}

export interface MailFields {
  subject: string | null
  from: MailPerson | null
  to: MailPerson[]
  cc: MailPerson[]
  bcc: MailPerson[]
  replyTo: MailPerson[]
  /** The Gmail labels or IMAP folders it is in. */
  labels: string[]
  /** The thread as a `chat:` reference. */
  thread: string
  read: boolean | null
  flagged: boolean | null
  /** How much the sender's mail looks like spam, a scam or a robot, and why; absent when the sender is not scored. */
  senderScore?: { score: number; signals: string[]; demoted?: true }
}

/** What happened to a message after it arrived, as `watch --events` prints it. */
export type MessageChange =
  | { event: "edit"; message: MessageHit }
  /** `chatId` is `null` where the provider does not say — Telegram's private chats and basic groups. */
  | { event: "delete"; chatId: Id | null; chatTitle: string | null; messageId: Id }
  | {
      event: "reaction"
      chatId: Id
      chatTitle: string | null
      messageId: Id
      reactions: Reactions
      counterObservation?: CounterObservation
    }

/** One person's vote in the poll `messageId` carries, replacing theirs before; no answers takes it back. */
export interface PollVoteEvent {
  event: "vote"
  chatId: Id
  chatTitle: string | null
  messageId: Id
  vote: PollVote
}

/** One person reacted to `messageId`, changed their reaction, or took it back; saved, an older one never wins. */
export interface PersonReactionEvent {
  event: "person_reaction"
  chatId: Id
  chatTitle: string | null
  messageId: Id
  reaction: PersonReaction
}

/** The owner starred a message or took the star off, here or on another device; saved, the same twice is one. */
export interface MessageStarEvent {
  event: "star"
  chatId: Id
  chatTitle: string | null
  messageId: Id
  starred: boolean
}

/** A receipt for the owner's own message in a one-to-one chat; saved, it never moves the stored state back. */
export interface MessageDeliveryEvent {
  event: "delivery"
  chatId: Id
  chatTitle: string | null
  messageId: Id
  delivery: Delivery
  /** ISO 8601 — when the receipt says it happened. */
  at: string
}

/** Who joined, left, was added, removed, promoted or demoted, or a new title, as it happens; saved for `chats events`. */
export interface ChatEventNotice {
  event: "chat_event"
  chatId: Id
  chatTitle: string | null
  change: ChatEvent
}

/** What a listening connection reports: a message, a change to one, a vote, a reaction, a star, a receipt, a chat change. */
export type MessageEvent =
  | { event: "message"; message: MessageHit }
  | MessageChange
  | PollVoteEvent
  | PersonReactionEvent
  | MessageStarEvent
  | MessageDeliveryEvent
  | ChatEventNotice

/** One chat's share of `inbox`: other people's messages since the last check, oldest first. */
export interface InboxChat extends Pick<Chat, "id" | "title" | "kind" | "unreadCount"> {
  /** A chat marked unread with nothing counted: its newest message from someone else. */
  messages: Message[]
  /** There are more than `--limit`; these are the newest of them. */
  more: boolean
}

export interface Inbox {
  /** `unread` — what the provider counts unread; `new` — what arrived since the last check. */
  mode: "unread" | "new"
  /** ISO 8601, `new` only. `until` is where the next check starts. */
  since?: string
  until?: string
  chats: InboxChat[]
  /** Past the per-run cap on history requests, so not read. */
  skipped: Pick<Chat, "id" | "title" | "lastMessageAt">[]
  /** The messenger could not list every chat, so one it left out may have more. */
  partial: boolean
  /** Muted or archived chats with something waiting, left out because nothing in them is for the owner. */
  quiet: number
  /** `new` only: each chat read, and the time its next check starts from. */
  checked?: Record<Id, string>
}

/** One chat's share of `review`: both sides, oldest first, from `since` to `until`. */
export interface ReviewChat extends Pick<Chat, "id" | "title" | "kind"> {
  messages: Message[]
  /** The chat had more in the window than one review reads; the newest are here. */
  more: boolean
  /** `--unanswered` only: whose words count as an answer. `owner` where the messenger did not say who the admins are. */
  answeredBy?: "owner" | "owner-and-admins"
}

/** `review`: everything said since a point, for someone sorting out who owes what. */
export interface Review {
  /** ISO 8601. `until` is where the next review starts. */
  since: string
  until: string
  /** Nothing skipped or cut short: the next review may start at `until`. */
  complete: boolean
  chats: ReviewChat[]
  skipped: Pick<Chat, "id" | "title" | "lastMessageAt">[]
  partial: boolean
  /** Muted or archived chats that changed, left out because nothing in them is for the owner. */
  quiet: number
  /** `--unanswered`: only questions still open after this many hours are in `chats`. */
  unanswered?: { olderThanHours: number }
  /** With saved points: each chat read whole, and the time its next check starts from. */
  checked?: Record<Id, string>
  /** Tasks the review opened and closed in the store, by the rules; absent when the store was not open. */
  tasks?: { added: number; closed: number; review: number }
  /** `--offline`: read from the local store, so it holds only what was already synced. */
  offline?: true
}

/** One change to who is in a chat, or to the chat itself, read from a service message. */
export interface ChatEvent {
  /** The service message, or the id the messenger gives the event: the same event always has the same one. */
  messageId: Id
  /** ISO 8601. */
  timestamp: string
  /** `join`, `leave`, `add`, `remove`, `promote`, `demote`, `create`, `title` or `pin`; a messenger may pass others. */
  event: string
  by: { id: Id | null; name: string | null }
  people: { id: Id; name: string | null }[]
  /** `create` and `title` carry the chat's title. */
  title?: string
}

export interface ChatEvents {
  chatId: Id
  since: string
  /** Oldest first. */
  events: ChatEvent[]
  /** More history than one run reads; the newest are here. */
  more: boolean
}

export interface Contact {
  alias?: string | null
  displayName?: string | null
  id: Id
  name: string | null
  /** The public handle, without `@`, when they have one. */
  username: string | null
  /** Whatever they wrote about themselves. */
  description: string | null
  /**
   * The newest message in a one-to-one chat with them, ISO 8601, and `null` for somebody met only
   * in a group. It is what `--order recent` sorts on, and it comes from the chat, not the contact.
   */
  lastMessagedAt: string | null
}

/** Somebody in a chat, as much of them as a chat card shows. */
export type Member = Pick<Contact, "id" | "name" | "username">

/** A topic of a forum group; its messages carry this id as `threadId`. */
export interface Topic {
  id: Id
  title: string
  closed: boolean
  pinned: boolean
  /** The General topic only, when the messenger says. */
  hidden?: boolean
  unreadCount: number | null
  /** ISO 8601. */
  lastMessageAt: string | null
  createdAt: string | null
}

/** Who the account may post as in one chat. `self` is the account itself, always offered. */
export interface SenderIdentity {
  id: Id
  title: string
  kind: "self" | "channel" | "group"
  /** The messenger asks for a paid account to post as this one. */
  premiumRequired: boolean
  /** The chat's saved choice; `self` when the chat has none. */
  default: boolean
}

/** What `topics edit` changes; a field left out stays. */
export interface TopicChange {
  title?: string
  closed?: boolean
  pinned?: boolean
  /** Only a forum's General topic can be hidden from the topic list. */
  hidden?: boolean
}

/** Someone who asked to join a group or channel that needs an admin's approval. */
export interface JoinRequest {
  person: Member
  /** When they asked; ISO 8601. `null` where the messenger does not say — MAX lists requests without a time. */
  requestedAt: string | null
  /** The note they sent with the request, when they wrote one. */
  about?: string
}

/** Where a channel post's comments are: its copy in the linked discussion group, which they reply to. */
export interface Discussion {
  chatId: Id
  messageId: Id
}

/** What a link leads to, read without joining. */
export interface LinkTarget {
  kind: ChatKind
  title: string | null
  /** `null` for a private chat the owner is not in: the invite does not say. */
  id: Id | null
  username: string | null
  participantsCount: number | null
  description: string | null
  /** Whether the owner is already in it; `null` where the messenger does not say. */
  member: boolean | null
  /** Joining waits for an admin's approval. */
  approvalNeeded?: boolean
}

/** Somewhere this account is logged in — a device, a browser, this tool. */
/** One call in the account's call history. */
export interface CallRecord {
  id: Id
  /** The dialog or group the call belongs to. */
  chatId: Id | null
  /** Who started it; the owner for an outgoing call. */
  callerId: Id | null
  direction: "incoming" | "outgoing"
  /** `missed`: not picked up; `declined`: turned down or called off; `answered`: talked. */
  outcome: "answered" | "missed" | "declined"
  kind: "audio" | "video"
  /** ISO 8601. */
  at: string
  /** Null when nobody talked. */
  durationSeconds: number | null
}

/** Who may do something to the owner: everyone, only contacts, or nobody. */
export type Audience = "everyone" | "contacts" | "nobody"

/**
 * An audience as `account privacy show` may report it: also the owner's contacts but some of them, which `set`
 * cannot choose. Kept apart from `Audience` so that a table keyed on it does not have to name it.
 */
export type ShownAudience = Audience | "contacts_except"

/** The account's privacy, as the messenger reports it; a setting it does not have is left out. */
export interface PrivacySettings {
  /** Who finds the account by its phone number. */
  findByPhone?: Audience
  /** Who sees the phone number. */
  phoneNumber?: Audience
  /** Whose calls ring; a call from anyone else is refused, or arrives without ringing. */
  calls?: Audience
  /** Who may add the account to groups and channels. */
  chatInvites?: Audience
  /** Whether online status and last seen are hidden. */
  hideOnline?: boolean
  /** Whether the owner sends read receipts. */
  readReceipts?: boolean
  /** Who sees the profile photo. */
  profilePhoto?: ShownAudience
  /** Who sees the about text — the profile's description. */
  about?: ShownAudience
  /** Who sees when the account was last online. */
  lastSeen?: ShownAudience
}

/** Every setting `account privacy set` knows. */
export type PrivacyKey = keyof PrivacySettings

/** A set of stickers the account has added. */
export interface StickerSet {
  id: Id
  title: string
  count: number
  /** Where others add it; null when the messenger gives none. */
  link: string | null
}

export interface Sticker {
  id: Id
  setId: Id | null
  /** The emoji it stands for, as the messenger tags it. */
  emoji: string[]
  /** Where its image is; null when the messenger gives none. */
  url: string | null
}

/** Kinds of attachment `chats media` filters by. */
export const MEDIA_KINDS = ["photo", "video", "file", "audio", "link"] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export interface AccountSession {
  /** The session this tool is using. */
  current: boolean
  /** The app and its version, as the messenger names it. */
  client: string | null
  /** The device and its system. */
  device: string | null
  location: string | null
  /** ISO 8601. */
  lastActiveAt: string | null
  createdAt?: string | null
}

/** Someone in a group as `chats members list` answers them. */
export interface GroupMember extends Member {
  /** Absent where the messenger does not say who runs the group. */
  role?: "owner" | "admin" | "member"
  /** ISO 8601, when they were last seen; `null` when their privacy hides it, absent where the messenger does not say. */
  lastSeenAt?: string | null
  /** ISO 8601, when their account was made; absent where the messenger does not say — Telegram never does. */
  registeredAt?: string | null
  /** ISO 8601, when they joined this group; `null` when the messenger did not say for this one. */
  joinedAt?: string | null
  /** Who added them or whose invite they used. */
  invitedBy?: Id | null
  isBot?: boolean
  /** The account was deleted; the member stays in the list. */
  deleted?: boolean
  /** What the messenger itself marked the account as. */
  flagged?: "scam" | "fake"
  hasPhoto?: boolean
}

/** One chat and who is in it. `members` is `null` where nobody recorded that — a channel, always. */
export interface ChatCard extends Chat {
  members: Member[] | null
}

/** One person and the chats this account shares with them, newest first. */
export interface PersonCard extends Contact {
  notes?: { id: string; personId: string; text: string; revision: number; createdAt: string; updatedAt: string }[]
  chats: Pick<Chat, "id" | "title" | "kind" | "lastMessageAt">[]
}

/**
 * When they were last seen: a time, or the bucket their privacy leaves — `hidden` only when the
 * messenger says nothing at all. Telegram answers `recently`, `week` or `month` instead of a time.
 */
export type Seen = "online" | "recently" | "week" | "month" | "hidden" | (string & {})

export type PersonFlag = "bot" | "verified" | "premium" | "scam" | "fake" | "restricted" | "deleted" | "support"

/**
 * When the account was made, and how that is known: `telegram` — Telegram's own month, sent only
 * when they first write to the owner; `max` — MAX's own time; `estimate` — guessed from the id,
 * weak. Never shown without its source.
 */
export interface Registered {
  at: string
  source: "telegram" | "max" | "estimate"
  /** How fine `at` is: Telegram tells a month, an estimate a month at best. */
  precision: "day" | "month"
}

/** Everything the messenger itself says about one person, as `contacts show` reads it. */
export interface ProfileFacts {
  id: Id
  name: string | null
  /** Every public handle, without `@`, the main one first. */
  usernames: string[]
  bio: string | null
  /** `DD.MM` or `DD.MM.YYYY`, where they show it. */
  birthday?: string | null
  /** Only where the messenger shows it to the owner. */
  phone?: string | null
  /** Only the flags the messenger answered; a missing one is not known. */
  flags: Partial<Record<PersonFlag, boolean>>
  /** Absent where the messenger does not say. */
  seen?: Seen
  /** In the owner's address book. */
  contact?: boolean
  /** And the owner in theirs. */
  mutualContact?: boolean
  /** The messenger's own count of groups shared with them. */
  commonChatsCount?: number | null
  registered?: Registered | null
  /** A photo of their own; one the owner set for them does not count. */
  hasPhoto?: boolean
  /** The chats shared with them, as the messenger lists them, newest first. */
  chats: Pick<Chat, "id" | "title" | "kind" | "lastMessageAt">[]
}

/** One chat shared with a person, and what the store holds of their messages there. */
export interface SharedChatActivity {
  id: Id
  title: string | null
  kind: ChatKind
  /** Their messages stored; a floor unless `complete`. */
  theirMessages: number
  firstAt: string | null
  lastAt: string | null
  /** The store holds the whole chat, so the count is the real one. */
  complete: boolean
}

/**
 * A name or username the store saw a person with. `profile` — their profile changed while the store watched;
 * `messages` — the name on their stored messages, approximate, since a message fetched again carries the newest.
 */
export interface PersonAlias {
  name?: string
  username?: string
  /** Their profile address under that username, where the messenger has one. */
  link?: string
  /** ISO 8601: the first and the last time the store recorded it. */
  firstSeenAt: string
  lastSeenAt: string
  source: "profile" | "messages"
}

/** `contacts show`: the person, and their activity in every chat shared with them. */
export interface PersonProfile extends Omit<ProfileFacts, "chats"> {
  chats: SharedChatActivity[]
  /** Earlier names and usernames, oldest first; the current ones are not repeated. */
  aliases: PersonAlias[]
}

/**
 * One page of a listing, and **the same shape whether it came from the provider or from the
 * store** — where rows come from is the exit code's business and the diagnostics', never the
 * answer's. `hasMore` rather than a total: counting rows nobody has fetched is a second cost.
 */
export interface Page<T> {
  items: T[]
  hasMore: boolean
}

/** Who a profile is logged in as. */
export interface Account {
  id: Id
  name: string | null
  /** The public handle, without `@`, when there is one. */
  username: string | null
  /** The whole number, where the messenger tells it; `--hide-phone` leaves it out. */
  phone?: string | null
}

export interface Profile {
  id: Id
  name: string | null
  phone: string | null
  description: string | null
}

/** One message of a window around another, which carries `anchor: true`. */
export type WindowedMessage = Message & { anchor?: true }

/** A number the messenger reports for its period, beside the same number for the period before. */
export interface OfficialValue {
  current: number
  previous: number
}

/**
 * One of the messenger's own graphs, colours and zoom dropped. `x.type` is read from the points:
 * `date` for UTC day starts (`YYYY-MM-DD`), `time` for other moments (ISO 8601), `number` as given.
 */
export interface OfficialGraph {
  kind: string
  x: { type: "date" | "time" | "number"; values: (string | number)[] }
  series: { key: string; name: string; kind: string; values: number[] }[]
  stacked?: boolean
  percentage?: boolean
}

/** A graph the messenger could not give; the other graphs still answer. */
export interface OfficialGraphError {
  error: string
}

export interface OfficialPerson {
  person: Id
  name: string | null
}

interface OfficialStatsBase {
  version: 1
  chat: { id: Id; title: string }
  /** The messenger chooses the period; ISO 8601. */
  period: { since: string; until: string }
}

export interface OfficialGroupStats extends OfficialStatsBase {
  kind: "group"
  totals: Record<"members" | "messages" | "viewers" | "posters", OfficialValue>
  top: {
    posters: (OfficialPerson & { messages: number; averageChars: number })[]
    admins: (OfficialPerson & { deleted: number; removed: number; banned: number })[]
    inviters: (OfficialPerson & { invited: number })[]
  }
  graphs: Record<string, OfficialGraph | OfficialGraphError>
}

export interface OfficialChannelStats extends OfficialStatsBase {
  kind: "channel"
  totals: Record<
    | "followers"
    | "viewsPerPost"
    | "sharesPerPost"
    | "reactionsPerPost"
    | "viewsPerStory"
    | "sharesPerStory"
    | "reactionsPerStory",
    OfficialValue
  >
  notifications: { enabled: number; total: number }
  recentPosts: { kind: "message" | "story"; id: Id; views: number; forwards: number; reactions: number }[]
  graphs: Record<string, OfficialGraph | OfficialGraphError>
}

/** What the messenger itself computed for a group or channel, as it shows its admins. */
export type OfficialChatStats = OfficialGroupStats | OfficialChannelStats
