import { CliError } from "@wirecat/cli-base"
import type { StickerFile, Upload } from "../domain/attachments.js"
import type { CounterField, CounterObservations } from "../domain/counters.js"
import type { HtmlFormatting, MarkdownFormatting, TextSpan } from "../domain/formatting.js"
import type { Markup } from "../domain/markdown.js"
import type { MessagePermalink } from "../domain/message-link.js"
import type {
  Account,
  AccountSession,
  AddressBookEntry,
  AdminRight,
  Button,
  CallRecord,
  Chat,
  ChatCard,
  ChatEvent,
  ChatEvents,
  ChatUpdate,
  Discussion,
  Folder,
  FolderChange,
  FolderRules,
  GroupCard,
  GroupChange,
  GroupMember,
  Id,
  InviteLink,
  InviteLinkChange,
  JoinRequest,
  LinkTarget,
  MediaKind,
  Member,
  Message,
  MessageEvent,
  MessageHit,
  OfficialChatStats,
  Page,
  PersonCard,
  PersonReaction,
  PhoneBookEntry,
  Poll,
  PollVote,
  PrivacySettings,
  ProfileFacts,
  ProviderMetadata,
  Reactor,
  SenderIdentity,
  Sticker,
  StickerSet,
  Topic,
  TopicChange,
  WindowedMessage,
} from "../domain/models.js"

/** One attachment's bytes, fetched over the adapter's connection when `bytes` is read — so read it before the command closes. */
export interface RemoteFile {
  kind: string
  /** As the sender named it: other people's text, never a path to trust. */
  name?: string
  mime?: string
  size?: number
  /** Its place among the message's attachments, from 0. Without it the store matches files by kind and name. */
  position?: number
  bytes(): AsyncIterable<Uint8Array>
  /**
   * Set by the adapter while `bytes()` runs when the messenger handed out a new reference for the file (WhatsApp
   * re-uploads an expired one). The whole ref, not a patch: it replaces the stored one, so a later download or a
   * forward uses it. Read only after `bytes()` ends. Saved only on the stored attachment the file matches, which
   * `position` makes certain; a ref the store could not place is dropped with a warning.
   */
  providerRef?: ProviderMetadata
}

/** A message's files, and the kinds of attachment it has that are not files — a poll, a location. */
export interface Download {
  files: RemoteFile[]
  skipped: string[]
}

/** How one message goes. `markup` spans `text` as sent — the marks already taken out of it. */
export interface SendOptions {
  sendId: string
  /** A message id in the same chat. */
  replyTo?: Id
  threadId?: Id
  /** Delivered without a notification. */
  silent?: boolean
  /** No preview card for a link in the text. */
  noPreview?: boolean
  markup?: Markup[]
  formatting?: TextSpan[]
  /** ISO time: the messenger holds it and sends it then, under a new id. */
  at?: string
  /**
   * Sent in one message, `text` as the caption. More than one is an album: photos first, then files, each in the
   * order given. An adapter whose messenger cannot send one refuses it with `validation_error` before anything goes.
   */
  attachments?: Upload[]
  /** One sticker by id, alone: no text, no attachment. Only where `Messenger.stickers` is on. */
  sticker?: Id
  /** One .webp sent as a sticker, alone: no text, no attachment. Only where `Messenger.stickerFileBytes` is set. */
  stickerFile?: StickerFile
  /** The photo or video hidden until tapped. Only where `Messenger.mediaOptions` has it. */
  spoiler?: boolean
  /** The caption shown above the attachment. Only where `Messenger.mediaOptions` has it. */
  captionAbove?: boolean
  /** One of `sendAsIdentities`' ids, already checked against them. */
  sendAs?: Id
}

/** A voice message as text. `pending`: the messenger was still working on it when it answered. */
export interface Transcript {
  text: string
  pending: boolean
}

/** A message id — exact within one chat — or a moment in ms, which works in every chat. */
export type After = { id: Id } | { time: number }

/** What `polls create` asks for. */
export interface NewPoll {
  question: string
  answers: string[]
  multiple: boolean
  anonymous: boolean
  /** People may change their vote. Without it they cannot, in every messenger. */
  revote?: boolean
  /** A quiz: `correct` is the right answer's index from 0, `solution` what is shown once someone answers. */
  quiz?: { correct: number; solution?: string }
  /** Seconds after sending when it closes by itself. */
  closeAfter?: number
}

export interface Sent {
  /** The message sent; for an album, its first. */
  message: Message
  /**
   * For an album, every message it made, in order, `message` among them. Unset for a single message, and where an
   * adapter has not learned to answer with them yet.
   */
  messages?: Message[]
  /** The send's identity. Repeat it after an unknown outcome, never a new one. */
  sendId: string
}

/** What every messenger does: `messages send` and the account and chat lookups stand on these. */
export interface MessengerCore {
  /** The logged-in account's id, from what is stored locally — no request. `null` before a login. */
  self(): Id | null
  /**
   * A send id in the form this messenger's own client makes one, when that is not any 64-bit
   * number — MAX's is a millisecond timestamp. Without it, `newSendId`.
   */
  newSendId?(): string
  me(): Promise<Account>
  resolve(chat: string): Promise<Chat>
  /** One chat and who is in it; `members` is `null` where the messenger does not say — a channel, a hidden list. */
  chat(chat: string): Promise<ChatCard>
  /** An option the messenger has no way to honour is refused, never dropped. */
  send(chatId: Id, text: string, options: SendOptions): Promise<Sent>
  /** Save a nonempty draft for the owner to review and send; never sends a message. */
  saveDraft?(
    chatId: Id,
    text: string,
    options: Pick<SendOptions, "replyTo" | "threadId" | "formatting" | "noPreview">,
  ): Promise<void>
  logout(): Promise<void>
  close(): Promise<void>
}

/**
 * Reads the messenger answers from its server. A messenger whose history is pushed to it
 * (`Messenger.history: "store"`) leaves them out: the services answer those reads from the store.
 */
export interface ServerReads {
  chats(window: { limit?: number; offset: number }): Promise<Page<Chat>>
  /**
   * Oldest to newest. `before` is a message id, or whatever the messenger pages by, as typed.
   * `reactions: false` when they are not wanted — `messages sync` — where reading them costs a request.
   */
  history(chat: string, window: { limit: number; before?: string; reactions?: false }): Promise<Page<Message>>
  /** One person and the chats this account shares with them, newest first. A chat that is not a person is refused. */
  contact(person: string): Promise<PersonCard>
  /** One message and up to `before` and `after` either side, oldest first; the one asked for carries `anchor`. */
  fetchCounters?(
    chat: string,
    messageId: Id,
    fields: readonly CounterField[],
    signal?: AbortSignal,
  ): Promise<CounterObservations>
  around(chat: string, messageId: Id, window: { before: number; after: number }): Promise<WindowedMessage[]>
}

/** Reading beyond the core: forward from a point, back from a moment, a forum's topics, where a link leads. */
export interface ChatReading {
  /** The oldest `limit` newer than a message or a moment, oldest first; `hasMore` when newer ones remain. */
  historyAfter(chat: string, window: { limit: number; after: After }): Promise<Page<Message>>
  /** The newest `limit` sent before a moment, epoch milliseconds, oldest first; `hasMore` when older ones remain. */
  historyBefore(chat: string, window: { limit: number; time: number }): Promise<Page<Message>>
  /** A forum group's topics, newest activity first; `search` matches their titles. */
  topics(chat: string, window: { search?: string; limit?: number; offset: number }): Promise<Page<Topic>>
  /** One forum topic; a topic that is not there is `not_found`, a chat that is not a forum `validation_error`. */
  topic?(chat: string, topicId: Id): Promise<Topic>
  /** What an invite or public link leads to. Reading it joins nothing. */
  inspect(link: string): Promise<LinkTarget>
}

/** A messenger that can search a chat by who wrote. */
export interface SenderSearch {
  /** One person's newest `limit` messages in a chat, oldest first — a search by sender, not a walk of the history. */
  historyFrom(chat: string, person: Id, window: { limit: number }): Promise<Page<Message>>
}

/** What a server search is asked: words as the server reads them, and the filters it takes. */
export interface ServerQuery {
  text: string
  /** One chat; every chat of the account when unset. */
  chat?: string
  /** One sender, honoured only with `chat`. */
  from?: Id
  /** Epoch milliseconds, inclusive. */
  minDate?: number
  maxDate?: number
}

/** A messenger whose server searches message text. Its matching is its own: the results are candidates. */
export interface MessageSearch {
  /** The newest `limit` matches, newest first; `chats` are the chats they came from. */
  searchMessages(
    query: ServerQuery,
    window: { limit: number; signal?: AbortSignal },
  ): Promise<Page<MessageHit> & { chats: Chat[] }>
}

/** Changing a message already sent, or passing it on. */
export interface MessageEditing {
  /**
   * The new text of one of the owner's own messages; the answer is the message as it now stands.
   * `markup` spans `text` as `SendOptions.markup` does.
   */
  edit(
    chatId: Id,
    messageId: Id,
    text: string,
    options: { markup?: Markup[]; formatting?: TextSpan[] },
  ): Promise<Message>
  /**
   * One message into another chat; the answer is the copy there. `silent` delivers it without a
   * notification. A repeat with the same `sendId` must leave one copy, as a send does. `threadId` is a forum
   * topic of the target chat, already checked with `validateThread`.
   */
  forward(
    fromChatId: Id,
    messageId: Id,
    toChatId: Id,
    options: { sendId: string; silent?: boolean; sendAs?: Id; threadId?: Id },
  ): Promise<Message>
  /** For the owner only, unless `forEveryone`; neither can be undone. */
  delete(chatId: Id, messageIds: Id[], options: { forEveryone: boolean }): Promise<void>
}

export interface MessagePins {
  /**
   * `notify` tells the chat's members; without it the pin is quiet. `duration` is how many seconds the pin lasts,
   * one of `MessengerTraits.pinDurations`, or its `pinDefaultDuration` when the caller gave none; absent when neither.
   */
  pin(chatId: Id, messageId: Id, options: { notify: boolean; duration?: number }): Promise<void>
  unpin(chatId: Id, messageId: Id): Promise<void>
}

export interface MessageStars {
  /** Stars one message, or takes the star off; only the owner sees it. */
  star(chatId: Id, messageId: Id, starred: boolean): Promise<void>
}

export interface MessageReactions {
  /** The owner's reaction on one message: an emoji replaces the one there was, `null` takes it off. */
  react(chatId: Id, messageId: Id, emoji: string | null): Promise<void>
  /**
   * Who reacted, newest first; `emoji` keeps one reaction, `cursor` is the last page's. Refuses with a
   * `reactions.*` reason where the messenger hides the list, rather than answering with none.
   */
  reactors?(
    chatId: Id,
    messageId: Id,
    window: { limit: number; emoji?: string; cursor?: string },
  ): Promise<Page<Reactor> & { cursor?: string }>
}

export interface ReadState {
  /** Marks the chat read up to `until`, or to its newest message; the other side sees it. */
  markRead(chatId: Id, until?: Id): Promise<void>
}

/** Only for a messenger with forum topics (`Messenger.topics`); one without them implements `ReadState` alone. */
export interface TopicReadState {
  /** One forum topic only, up to `until` or its newest message; the rest of the chat stays as it is. */
  markTopicRead(chatId: Id, topicId: Id, until?: Id): Promise<void>
}

export interface ForumState {
  chat: Chat
  forum: boolean
  needsUpgrade: boolean
  owner: boolean
  linkedDiscussion: boolean
  canCreate: boolean
}

export interface ForumControl {
  forumState(chatId: Id): Promise<ForumState>
  upgradeForum(chatId: Id): Promise<ForumState>
  enableForum(chatId: Id): Promise<ForumState>
  createTopic(chatId: Id, title: string, options: { sendId: string }): Promise<Topic>
}

export interface TopicEditing {
  /** Renames, closes or reopens one topic; the answer is the topic as it now stands. A repeat changes nothing. */
  editTopic(chatId: Id, topicId: Id, change: TopicChange): Promise<Topic>
  /** Puts the pinned topics in this order; a topic that is not pinned stays unpinned. */
  orderPinnedTopics(chatId: Id, topicIds: Id[]): Promise<void>
  /** Deletes the topic and every message in it, for everyone; it cannot be undone. A topic that is gone is `not_found`. */
  deleteTopic?(chatId: Id, topicId: Id): Promise<void>
}

export interface ThreadAddressing {
  validateThread(chatId: Id, threadId: Id, options: { replyTo?: Id }): Promise<void>
}

export interface TopicHistory {
  /** One forum topic's messages, oldest to newest; `before` a message id. */
  topicHistory(chat: string, threadId: Id, window: { limit: number; before?: string }): Promise<Page<Message>>
}

export interface MessageButtons {
  /** The keyboard one message carries, row by row; a message without one answers `[]`. */
  buttons(chatId: Id, messageId: Id): Promise<Button[][]>
  /** Presses one `callback` button, by its row and column from 0. */
  pressButton(chatId: Id, messageId: Id, row: number, column: number): Promise<void>
}

export interface MessagePolls {
  /** The poll one message carries; a message without one is `not_found`. */
  poll(chatId: Id, messageId: Id): Promise<Poll>
  /** The owner's vote, by answer ids; none takes it back. An id the poll does not have is refused. */
  vote(chatId: Id, messageId: Id, answerIds: Id[]): Promise<Poll>
  /** Only the owner's own poll; it cannot be reopened. */
  closePoll(chatId: Id, messageId: Id): Promise<Poll>
  /** Who voted, newest first; `answerId` keeps those who chose it. Only for a poll that is not anonymous. */
  pollVoters?(
    chatId: Id,
    messageId: Id,
    window: { limit: number; answerId?: Id },
  ): Promise<Page<PollVote> & { total: number }>
  createPoll(
    chatId: Id,
    poll: NewPoll,
    options: { sendId: string; silent?: boolean; threadId?: Id; sendAs?: Id },
  ): Promise<Sent>
}

export interface LiveUpdates {
  /**
   * New messages and changes to messages as they arrive, until `signal` aborts. `onReady` once it is
   * actually listening — a caller that sends on "listening" must not race the connection. Only on a
   * connection opened with `{ listen: true }`; a messenger that cannot listen leaves it out.
   */
  watch(onEvent: (event: MessageEvent) => void, signal: AbortSignal, onReady?: () => void): Promise<void>
}

export interface PassiveUpdates {
  /**
   * What the open connection receives, as `watch` hands it, until `signal` aborts — on a connection opened without
   * `{ listen: true }`. It only listens: it never connects or waits for the connection, and it hands on what the
   * messenger queued while nothing was connected. For a messenger that cannot fetch those again
   * (`history: "store"`), which then saves them for a command that never watches. Resolves once nothing more will
   * be handed on.
   */
  listen(onEvent: (event: MessageEvent) => void, signal: AbortSignal): Promise<void>
  /**
   * What the open connection is pushed of the messenger's history, as `feed` hands it, until `signal` aborts — on
   * the same connections as `listen`, under the same rules: it never connects or waits for the connection, and
   * resolves once nothing more will be handed on. A messenger that pushes history once (`history: "store"`) then
   * has it saved by a command that never feeds. Optional within the group, so an adapter typed as having
   * `PassiveUpdates` before it existed still is one.
   */
  listenHistory?(onBatch: (batch: HistoryBatch) => void, signal: AbortSignal): Promise<void>
}

/** One voter's vote in the poll message `messageId` of `chatId` carries, as `PollVoteEvent` has it. */
export interface HistoryVote {
  chatId: Id
  messageId: Id
  vote: PollVote
}

/** One person's reaction to message `messageId` of `chatId`, as `PersonReactionEvent` has it. */
export interface HistoryReaction {
  chatId: Id
  messageId: Id
  reaction: PersonReaction
}

/** One change to who is in chat `chatId`, or to its title, as `ChatEventNotice` has it. */
export interface HistoryChatEvent {
  chatId: Id
  change: ChatEvent
}

/** The owner's star on message `messageId` of `chatId`, or its removal, as `MessageStarEvent` has it. */
export interface HistoryStar {
  chatId: Id
  messageId: Id
  starred: boolean
}

/**
 * What a messenger pushed in one go: any of chats, the people in them, past messages of any chats, votes in
 * their polls, each person's reactions, the owner's stars, and changes to who is in them. A vote, a reaction or a star
 * is saved with its chat's messages, after them, so a message in the same batch is held before them.
 * `rekeys` are chats the messenger now names by another id; they apply first, so the batch's messages under the
 * new id join the chat already stored under the old one.
 */
export interface HistoryBatch {
  rekeys?: { from: Id; to: Id }[]
  chats?: ChatUpdate[]
  people?: Member[]
  messages?: Message[]
  votes?: HistoryVote[]
  reactions?: HistoryReaction[]
  stars?: HistoryStar[]
  /** Deletions learned from a synced snapshot, scoped to their chat and applied after the batch's messages. */
  deletions?: { chatId: Id; messageId: Id }[]
  events?: HistoryChatEvent[]
}

/** For a messenger that pushes its history to the client instead of answering for it (`Messenger.history: "store"`). */
export interface PushedHistory {
  /** Chats, people and past messages as the messenger pushes them, until `signal` aborts. */
  feed(onBatch: (batch: HistoryBatch) => void, signal: AbortSignal): Promise<void>
  /**
   * Every chat id the store holds for this account, handed over once as `feed` starts, so a chat nothing names again
   * can still be re-keyed through a later batch's `rekeys`. `recipients`, when given, are ids the profile's recipient
   * list names and the store does not hold: typed by the owner, to be mapped from local data only, never looked up
   * over the network or recorded. A reject is a warning; `feed` goes on.
   */
  storedChats?(ids: readonly Id[], recipients?: readonly Id[]): void | Promise<void>
}

/** A message's files and its speech, fetched from the messenger. */
export interface MessageMedia {
  /** The files attached to one message, fetched fresh from the messenger: a stored reference may have expired. */
  download(chat: string, messageId: Id): Promise<Download>
  /** A voice or video note as text, by the messenger's own speech recognition. */
  transcribe(chat: string, messageId: Id): Promise<Transcript>
}

export interface MessagePermalinks {
  /** Validates the exact target before returning its permalink or unsupported-chat result. */
  permalink(chatId: Id, messageId: Id): Promise<MessagePermalink>
}

export interface SenderIdentities {
  /** Who the account may post as in this chat, itself included. Reading changes no saved choice. */
  sendAsIdentities(chatId: Id): Promise<SenderIdentity[]>
  /** Who the chat posts a message as when none is named — `null` when that is the account itself. */
  savedSender(chatId: Id): Promise<Id | null>
}

/** Invite links beyond the group's own one; making one tells nobody until it is shared. */
export interface InviteLinks {
  createInviteLink(
    chatId: Id,
    options: { approval: boolean; expiresAt?: string; maxUses?: number },
  ): Promise<InviteLink>
  /** The owner's own links, newest first; `revoked` lists the stopped ones instead. */
  inviteLinks?(chatId: Id, window: { limit: number; revoked: boolean }): Promise<Page<InviteLink>>
  /** Stops a link; for the group's own link the answer is the new one the messenger made. */
  revokeInviteLink?(chatId: Id, link: string): Promise<InviteLink>
  /** Changes only the fields given. */
  updateInviteLink?(chatId: Id, link: string, change: InviteLinkChange): Promise<InviteLink>
}

/** Requests to join a group or channel that needs approval; only its admins see them. */
export interface JoinRequests {
  /** Newest first. Reading them tells nobody. `search` matches their names; `link` keeps those who came by it. */
  joinRequests(
    chatId: Id,
    window: { limit: number; search?: string; link?: string },
  ): Promise<Page<JoinRequest> & { total?: number }>
  /**
   * Lets them in, or turns them away. `already` when they were a member before the answer; a request
   * that is gone — answered elsewhere or withdrawn — is `not_found`.
   */
  answerJoinRequest(chatId: Id, personId: Id, accept: boolean): Promise<{ already: boolean }>
  /** Every pending request, or those by `link`; one that arrives meanwhile is answered too. */
  answerAllJoinRequests?(chatId: Id, accept: boolean, link?: string): Promise<void>
}

/** Comments under a channel post, which live in the channel's linked discussion group. */
export interface ChannelComments {
  /** The post's copy in the discussion group; a post that takes no comments is `not_found`. */
  discussionOf(channelId: Id, postId: Id): Promise<Discussion>
  /** Oldest to newest, a page at a time; `before` a comment id. */
  comments(channelId: Id, postId: Id, window: { limit: number; before?: string }): Promise<Page<Message>>
}

export interface ScheduledMessages {
  /** Messages waiting to be sent later in a chat, soonest first, each with `scheduledFor`. */
  scheduled(chat: string): Promise<Message[]>
}

/** Who is in a group, who runs it, and who came and went. */
export interface GroupModeration {
  /**
   * Everyone in a group, a page at a time; `limit` unset is every one the messenger will give.
   * `participantsCount` is the group's own count when the same answer carries it, which the chat list may not.
   */
  members(
    chat: string,
    window: { limit?: number; offset: number },
  ): Promise<Page<GroupMember> & { chatId: Id; participantsCount?: number | null }>
  /** A group's admins, whose answer counts as the group's in `review --unanswered`; `null` where the group hides them. */
  admins(chat: string): Promise<Id[] | null>
  /** Who joined, left, was added or removed since `since` (ms), from the chat's service messages. */
  chatEvents(chat: string, window: { since: number }): Promise<ChatEvents>
}

/** The account itself: its sessions, and finding people outside the chats. */
export interface AccountTools {
  /** Every device and app logged in to this account. Reading them ends nothing. */
  sessions(): Promise<AccountSession[]>
  /** The person with this phone number, where their privacy lets the owner find them; `not_found` otherwise. */
  lookup(phone: string): Promise<Member>
  /** The owner's contact list as the messenger keeps it — the address book, not the chats. */
  addressBook(): Promise<AddressBookEntry[]>
}

/** Everything the messenger says about one person — what `contacts show` shows. */
export interface PersonProfiles {
  /** Reading it tells them nothing. A chat that is not a person is refused. */
  profile(person: string): Promise<ProfileFacts>
}

/** Their profile photos, for telling an account made last week from one with years of them. */
export interface ProfilePhotos {
  /** How many they show and the oldest one's upload time; reading them tells them nothing. */
  photos(person: Id): Promise<{ count: number; oldestAt: string | null }>
}

/** Making, joining and leaving groups. Everything here is seen by other people. */
export interface GroupAdmin {
  /** The person ids these references name — an id, a handle, a name — in the order given; one that is not a person is refused. */
  people(references: string[]): Promise<Id[]>
  /** A group, or a channel with `channel`, with these people in it; they are told they were added. */
  createGroup(title: string, people: Id[], options: { channel: boolean }): Promise<GroupCard>
  /**
   * By an invite or public link; the others in it see that the owner joined. `requested` where the
   * group's admins approve who joins: the request is sent, and the owner is not in it yet.
   */
  join(link: string): Promise<GroupCard | { requested: true }>
  /** The others see that the owner left. */
  leave(chat: string): Promise<{ chatId: Id }>
  /** A group's description, invite link and settings. Reading changes nothing. */
  group(chat: string): Promise<GroupCard>
  /** Title, description and settings at once; a setting this messenger lacks is refused, never dropped. */
  updateGroup(chatId: Id, change: GroupChange): Promise<GroupCard>
  /** A new invite link; the old one stops working. */
  resetInviteLink(chatId: Id): Promise<GroupCard>
  /** They are told. `notAdded`: who could not be, by their privacy or the group's limits — the rest are in. */
  addMembers(chatId: Id, people: Id[], options: { history?: boolean }): Promise<{ notAdded: Id[] }>
  /** Their messages stay. */
  removeMembers(chatId: Id, people: Id[]): Promise<void>
  /** A right this messenger lacks is refused, never dropped. */
  addAdmin(chatId: Id, person: Id, rights: AdminRight[]): Promise<void>
  /** They stay a member. */
  removeAdmin(chatId: Id, person: Id): Promise<void>
}

/** What `account update` changes; a field left out stays. */
export interface ProfileChange {
  firstName?: string
  lastName?: string
  /** "About": the line under the name. */
  description?: string
  photo?: Upload
}

/** The owner's own profile and logins — what everyone sees, and every device signed in. */
export interface AccountEditing {
  updateProfile(change: ProfileChange): Promise<Account>
  /** Every login but this one, the phone's included; answers the sessions that remain. */
  endOtherSessions(): Promise<AccountSession[]>
}

/** Reads of the account and its chats that only the messenger's server answers; reading changes nothing. */
export interface AccountRecords {
  /** Newest first. */
  calls(window: { limit: number }): Promise<Page<CallRecord>>
  privacy(): Promise<PrivacySettings>
  /** A chat's messages that carry these kinds of attachment, oldest first; `before` is a message id. */
  media(chatId: Id, window: { kinds: MediaKind[]; limit: number; before?: Id }): Promise<Page<Message>>
  /** The sets the account has added, in its order. */
  stickerSets(): Promise<StickerSet[]>
  stickers(setId: Id): Promise<Sticker[]>
}

/** Removing a chat or its messages from this account only; the others in it keep theirs. */
export interface ChatDeletion {
  deleteChat(chatId: Id): Promise<void>
  clearHistory(chatId: Id): Promise<void>
}

/** A bot in a one-to-one chat with the personal account. */
export interface BotChats {
  /** Starts the bot, as its Start button does; the payload is what the bot reads as its start parameter. */
  startBot(chatId: Id, options: { sendId: string; payload?: string }): Promise<void>
  /**
   * A bot's link, as the messenger hands it out, to the one-to-one chat with that bot and the start
   * parameter it carries; `undefined` for anything that is not such a link.
   */
  botByLink(reference: string): Promise<{ chatId: Id; payload?: string } | undefined>
  /** The address that opens the bot's mini app. It signs the owner in: a credential. */
  botApp(chatId: Id, options: { startParam?: string }): Promise<{ url: string }>
}

/** The owner's own settings; nobody else is told. */
export interface AccountSettings {
  /** `forever`, an ISO 8601 time, or null to hear the chat again. */
  mute(chatId: Id, until: string | null): Promise<void>
  /** Moves the chat into the archive, or back out of it with `false`. */
  archiveChat(chatId: Id, archived: boolean): Promise<void>
  /** Pins the chat at the top of the chat list, or unpins it with `false`; not a message pin. */
  pinChat(chatId: Id, pinned: boolean): Promise<void>
  /** Marks the chat unread on the owner's devices; no read receipt changes. */
  markChatUnread(chatId: Id): Promise<void>
  /** Only the settings named change; answers them all as they now are. One the messenger lacks is refused. */
  updatePrivacy(change: PrivacySettings): Promise<PrivacySettings>
}

/** The owner's address book. A person by id: `GroupAdmin.people` finds them. */
export interface ContactBook {
  /** Under the name they show, until the owner gives one. */
  addContact(personId: Id): Promise<Member>
  /** The chat stays. */
  removeContact(personId: Id): Promise<void>
  /** They need not be a contact. */
  block(personId: Id): Promise<void>
  unblock(personId: Id): Promise<void>
  /** A name only the owner sees. */
  renameContact(personId: Id, firstName: string, lastName?: string): Promise<Member>
  /** The people the messenger has under these numbers, added to the address book. */
  importContacts(entries: PhoneBookEntry[]): Promise<Member[]>
}

/** The owner's chat folders, which only the owner sees. */
export interface ChatFolders {
  /** In the order the messenger's app shows them. */
  folders(): Promise<Folder[]>
  /** `rules` only where `Messenger.folderRules` is set. */
  createFolder(title: string, chatIds: Id[], rules?: FolderRules): Promise<Folder>
  updateFolder(folderId: string, change: FolderChange): Promise<Folder>
  /** The chats in it stay. */
  deleteFolder(folderId: string): Promise<void>
  /** Every folder's id, in the new order. */
  orderFolders(folderIds: string[]): Promise<void>
  /** A folder someone shared by a link: joins every chat in it, and the others there see that the owner joined. */
  joinFolder(link: string): Promise<Folder>
}

/** What the messenger computes for a group or channel and shows only its admins. Reads only. */
export interface OfficialStats {
  officialChatStats(chat: string): Promise<OfficialChatStats>
}

/**
 * A state the messenger put the account in, where it is not simply logged in. An adapter reports
 * `frozen` from `health`; the others come as `details.standing` on the error its requests throw.
 * `limited` is a write refused as spam, with no end the messenger reports. Dates are ISO 8601.
 */
export interface AccountStanding {
  state: "frozen" | "limited" | "banned" | "deactivated" | "revoked"
  since?: string
  until?: string
  appealUrl?: string
  hint?: string
}

/** What `doctor --online` asks beyond the login. Reads only. */
export interface AccountHealth {
  health(): Promise<{
    /** Milliseconds since the epoch, as the messenger reported it during this call. */
    serverTime?: number
    /** 1000 when the messenger counts whole seconds; the round trip adds to it. */
    serverTimeResolutionMs?: number
    /** False when the messenger could not say whether the account is restricted; it is then `unknown`, never `active`. */
    standingChecked: boolean
    standing?: AccountStanding
  }>
}

/**
 * What a messenger does for the shared commands. Each CLI implements it over its own library, and
 * nothing of that library's shape crosses it. A chat is passed as typed — a title, an id, a handle —
 * because only the adapter knows how its messenger finds one.
 *
 * **Only `MessengerCore` is required; every group is optional**, so an adapter or a test fake that
 * lacks one still compiles, and the command asks for a method with `capability` — which refuses with
 * a message instead of crashing. An adapter that has a group can say `implements MessageEditing` to
 * be held to all of it. A method added from now on goes into a group, never the core, and returns a
 * promise: the wrappers time and pass it through without being told about it (`throughWrapper`).
 */
export interface MessengerAdapter
  extends MessengerCore,
    Partial<MarkdownFormatting>,
    Partial<HtmlFormatting>,
    Partial<ServerReads>,
    Partial<PersonProfiles>,
    Partial<ChatReading>,
    Partial<SenderSearch>,
    Partial<MessageSearch>,
    Partial<MessageEditing>,
    Partial<MessagePins>,
    Partial<MessageStars>,
    Partial<MessageReactions>,
    Partial<ReadState>,
    Partial<TopicReadState>,
    Partial<MessagePolls>,
    Partial<MessageButtons>,
    Partial<BotChats>,
    Partial<ThreadAddressing>,
    Partial<TopicHistory>,
    Partial<ForumControl>,
    Partial<TopicEditing>,
    Partial<LiveUpdates>,
    Partial<PassiveUpdates>,
    Partial<PushedHistory>,
    Partial<MessageMedia>,
    Partial<ScheduledMessages>,
    Partial<ChannelComments>,
    Partial<MessagePermalinks>,
    Partial<SenderIdentities>,
    Partial<GroupModeration>,
    Partial<AccountTools>,
    Partial<ProfilePhotos>,
    Partial<GroupAdmin>,
    Partial<JoinRequests>,
    Partial<InviteLinks>,
    Partial<ChatFolders>,
    Partial<ContactBook>,
    Partial<AccountEditing>,
    Partial<AccountRecords>,
    Partial<AccountSettings>,
    Partial<ChatDeletion>,
    Partial<AccountHealth>,
    Partial<OfficialStats> {}

type Method = (...args: never[]) => unknown

/**
 * `handled` for the methods a wrapper knows; any other method of `inner` still answers, through
 * `wrap`. So a method added to the adapter reaches the command without an edit to every wrapper.
 */
export const throughWrapper = (
  inner: MessengerAdapter,
  handled: MessengerAdapter,
  wrap: (name: string, call: (...args: unknown[]) => Promise<unknown>) => Method = (_, call) => call,
): MessengerAdapter =>
  new Proxy(handled, {
    get: (own, key) => {
      if (key in own) return own[key as keyof MessengerAdapter]
      const value = inner[key as keyof MessengerAdapter] as unknown
      return typeof value === "function"
        ? wrap(String(key), (...args) => (value as (...a: unknown[]) => Promise<unknown>).apply(inner, args))
        : value
    },
    has: (own, key) => key in own || key in inner,
  })

/** The adapter's `method`, or a refusal naming what this messenger cannot do. */
export const capability = <K extends keyof MessengerAdapter>(
  adapter: MessengerAdapter,
  method: K,
  what: string,
): NonNullable<MessengerAdapter[K]> => {
  const found = adapter[method]
  if (typeof found !== "function") throw new CliError("validation_error", `this messenger cannot ${what}`)
  return found.bind(adapter) as NonNullable<MessengerAdapter[K]>
}
