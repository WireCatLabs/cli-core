import { CliError } from "@wirecat/cli-base"
import type {
  AccountEditing,
  AccountTools,
  ChatFolders,
  ChatReading,
  ContactBook,
  GroupAdmin,
  GroupModeration,
  HistoryBatch,
  LiveUpdates,
  MessageEditing,
  MessageMedia,
  MessagePins,
  MessagePolls,
  MessageReactions,
  MessengerCore,
  PushedHistory,
  ReadState,
  ScheduledMessages,
  Sent,
  ServerReads,
} from "../cli/messenger/port.js"
import type {
  Account,
  AccountSession,
  Chat,
  Contact,
  Folder,
  FolderRules,
  GroupCard,
  GroupMember,
  GroupSettings,
  Id,
  Member,
  Message,
  MessageEvent,
  Page,
  Poll,
} from "../domain/models.js"
import { isId, pickChat, pickPerson } from "../resolve.js"
import { uploadSource } from "../sends/upload.js"
import { uploadSize } from "../sends/upload-source.js"
import { contractSeed, type Seed } from "./seed.js"

/** Every group of the port, over memory. */
export type FakeAdapter = MessengerCore &
  ServerReads &
  ChatReading &
  MessageEditing &
  MessagePins &
  MessageReactions &
  ReadState &
  MessagePolls &
  LiveUpdates &
  MessageMedia &
  ScheduledMessages &
  GroupModeration &
  AccountTools &
  GroupAdmin &
  ChatFolders &
  ContactBook &
  AccountEditing &
  Partial<PushedHistory>

const NO_SETTINGS: GroupSettings = {
  allCanPin: null,
  onlyAdminsAdd: null,
  onlyAdminsCall: null,
  onlyOwnerEditsInfo: null,
  membersSeeLink: null,
}

/** `before` as a time, for a messenger whose store pages by time (`Fetching.orderBy`). */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/

const THIS_SESSION: AccountSession = { current: true, client: "fake", device: null, location: null, lastActiveAt: null }

const page = <T>(all: T[], window: { limit?: number; offset: number }): Page<T> => {
  const end = window.limit === undefined ? all.length : window.offset + window.limit
  return { items: all.slice(window.offset, end), hasMore: end < all.length }
}

const newest = <T>(all: T[], limit: number): Page<T> => ({
  items: all.slice(Math.max(0, all.length - limit)),
  hasMore: all.length > limit,
})

const missing = (what: string): CliError => new CliError("not_found", `the fake adapter has no ${what}`)

/**
 * A messenger in memory, over `seed` (`contractSeed()` when not given), copied so a test may keep
 * using its seed. It keeps the port's promises — oldest first, `hasMore`, a repeated send id leaving
 * one message, `CliError` codes — and passes `contractCases`. Writes change only its own copy.
 *
 * With `{ feed: true }` it also pushes its history, as a messenger with `history: "store"` does:
 * the chats and people in one batch, then each chat's messages in a batch of their own.
 */
const withRules = (folder: Folder, { emoji, include, skip, exclude, pin }: FolderRules): void => {
  if (emoji !== undefined) folder.emoji = emoji
  if (include !== undefined) folder.include = include
  if (skip !== undefined) folder.skip = skip
  if (exclude?.length) folder.excludedChatIds = [...new Set([...(folder.excludedChatIds ?? []), ...exclude])]
  if (pin?.length) folder.pinnedChatIds = [...new Set([...(folder.pinnedChatIds ?? []), ...pin])]
}

export const fakeAdapter = (seed: Seed = contractSeed(), options: { feed?: boolean } = {}): FakeAdapter => {
  const state = structuredClone(seed)
  let account: Account | null = state.account
  const sends = new Map<string, Sent>()
  const pins = new Map<Id, Id>()
  const polls = new Map<string, Poll>()
  const scheduled: Message[] = []
  const admins = new Map<Id, Id[]>()
  const groups = new Map<Id, { description: string | null; link: string | null; settings: GroupSettings }>()
  const contacts = new Set<Id>(state.people.map((person) => person.id))
  const blocked = new Set<Id>()
  const folders: Folder[] = []
  const listeners = new Set<(event: MessageEvent) => void>()
  let counter = 0

  const ownId = (): Id => {
    if (!account) throw new CliError("authentication_error", "the fake adapter is not logged in")
    return account.id
  }
  const chatOf = (reference: string): Chat => {
    const exact = state.chats.find((chat) => chat.id === reference)
    if (exact) return exact
    if (isId(reference)) throw missing(`chat ${reference}`)
    return pickChat(reference, state.chats)
  }
  const messagesOf = (chatId: Id) => state.messages.filter((message) => message.chatId === chatId)
  const messageOf = (chatId: Id, messageId: Id): Message => {
    const found = state.messages.find((message) => message.chatId === chatId && message.id === messageId)
    if (!found) throw missing(`message ${messageId} in chat ${chatId}`)
    return found
  }
  const personOf = (reference: string): Contact =>
    pickPerson(reference, {
      get: (id) => state.people.find((person) => person.id === id),
      all: () => state.people,
    })
  const nextId = (prefix: string): Id => {
    counter += 1
    const numeric = state.messages.every((message) => /^\d+$/.test(message.id))
    if (!numeric) return `new-${prefix}-${counter}`
    return String(Math.max(0, ...state.messages.map((message) => Number(message.id))) + 1)
  }
  const later = (chatId: Id): string => {
    const last = messagesOf(chatId).at(-1)
    const after = last ? Date.parse(last.timestamp) + 1000 : 0
    return new Date(Math.max(Date.now(), after)).toISOString()
  }
  const compose = (chat: Chat, text: string, extra: Partial<Message> = {}): Message => ({
    id: nextId("sent"),
    chatId: chat.id,
    senderId: ownId(),
    senderName: account?.name ?? null,
    timestamp: later(chat.id),
    editedAt: null,
    text,
    outgoing: true,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
    ...extra,
  })
  const post = (chat: Chat, text: string, extra: Partial<Message> = {}): Message => {
    const message = compose(chat, text, extra)
    state.messages.push(message)
    chat.lastMessageAt = message.timestamp
    for (const listener of listeners) listener({ event: "message", message: { ...message, chatTitle: chat.title } })
    return message
  }
  const once = (sendId: string, make: () => Sent): Sent => {
    const known = sends.get(sendId)
    if (known) return known
    const sent = make()
    sends.set(sendId, sent)
    return sent
  }
  const cardOf = (chat: Chat): GroupCard => ({ ...chat, ...(groups.get(chat.id) ?? groupDefaults()) })
  const groupDefaults = () => ({ description: null, link: null, settings: { ...NO_SETTINGS } })
  const groupOf = (chatId: Id) => {
    const existing = groups.get(chatId)
    if (existing) return existing
    const fresh = groupDefaults()
    groups.set(chatId, fresh)
    return fresh
  }
  const pollOf = (chatId: Id, messageId: Id): Poll => {
    const found = polls.get(`${chatId}/${messageId}`)
    if (!found) throw missing(`poll on message ${messageId}`)
    return found
  }
  const asMember = ({ id, name, username }: Contact): Member => ({ id, name, username })
  const folderOf = (folderId: string): Folder => {
    const found = folders.find((folder) => folder.id === folderId)
    if (!found) throw missing(`folder ${folderId}`)
    return found
  }

  return {
    self: () => account?.id ?? null,
    me: async () => {
      ownId()
      return { ...(account as Account) }
    },
    chats: async (window) => page(structuredClone(state.chats), window),
    history: async (reference, { limit, before }) => {
      const all = messagesOf(chatOf(reference).id)
      if (before === undefined) return structuredClone(newest(all, limit))
      const index = all.findIndex((message) => message.id === before)
      const time = ISO_TIME.test(before) ? Date.parse(before) : Number.NaN
      if (index === -1 && Number.isNaN(time)) throw missing(`message ${before}`)
      const older = index === -1 ? all.filter((message) => Date.parse(message.timestamp) < time) : all.slice(0, index)
      return structuredClone(newest(older, limit))
    },
    resolve: async (reference) => ({ ...chatOf(reference) }),
    chat: async (reference) => {
      const chat = chatOf(reference)
      return { ...chat, members: chat.kind === "channel" ? null : structuredClone(state.members[chat.id] ?? []) }
    },
    contact: async (reference) => {
      const chat = state.chats.find((one) => one.id === reference)
      if (chat && chat.kind !== "dialog") throw new CliError("validation_error", `${reference} is a chat, not a person`)
      const partner = chat && state.members[chat.id]?.find((member) => member.id !== account?.id)
      const person = personOf(partner?.id ?? reference)
      const shared = state.chats
        .filter((one) => state.members[one.id]?.some((member) => member.id === person.id))
        .map(({ id, title, kind, lastMessageAt }) => ({ id, title, kind, lastMessageAt }))
      return { ...person, chats: shared }
    },
    around: async (reference, messageId, { before, after }) => {
      const all = messagesOf(chatOf(reference).id)
      const index = all.findIndex((message) => message.id === messageId)
      if (index === -1) throw missing(`message ${messageId}`)
      return structuredClone(all.slice(Math.max(0, index - before), index + after + 1)).map((message) =>
        message.id === messageId ? { ...message, anchor: true as const } : message,
      )
    },
    send: async (chatId, text, options) =>
      once(options.sendId, () => {
        const chat = chatOf(chatId)
        const attachments = (options.attachments ?? []).map((upload) => ({
          kind: upload.kind,
          name: upload.name,
          size: uploadSize(uploadSource(upload)),
        }))
        const extra = { attachments, ...(options.replyTo === undefined ? {} : { replyToId: options.replyTo }) }
        if (options.at === undefined) return { message: post(chat, text, extra), sendId: options.sendId }
        const message = compose(chat, text, { ...extra, scheduledFor: options.at })
        scheduled.push(message)
        return { message, sendId: options.sendId }
      }),
    logout: async () => {
      account = null
    },
    close: async () => {
      listeners.clear()
    },

    historyAfter: async (reference, { limit, after }) => {
      const all = messagesOf(chatOf(reference).id)
      const newer =
        "id" in after
          ? all.slice(all.findIndex((message) => message.id === after.id) + 1)
          : all.filter((message) => Date.parse(message.timestamp) > after.time)
      return structuredClone({ items: newer.slice(0, limit), hasMore: newer.length > limit })
    },
    historyBefore: async (reference, { limit, time }) =>
      structuredClone(
        newest(
          messagesOf(chatOf(reference).id).filter((message) => Date.parse(message.timestamp) < time),
          limit,
        ),
      ),
    topics: async (reference) => {
      chatOf(reference)
      return { items: [], hasMore: false }
    },
    inspect: async (link) => {
      throw missing(`chat behind ${link}`)
    },

    edit: async (chatId, messageId, text) => {
      const message = messageOf(chatId, messageId)
      if (!message.outgoing) throw new CliError("permission_error", "only the owner's own message can be edited")
      message.text = text
      message.editedAt = new Date().toISOString()
      return { ...message }
    },
    forward: async (fromChatId, messageId, toChatId, { sendId }) =>
      once(sendId, () => {
        const original = messageOf(fromChatId, messageId)
        const forwardedFrom = {
          id: original.id,
          senderId: original.senderId,
          senderName: original.senderName,
          timestamp: original.timestamp,
          text: original.text,
          attachments: original.attachments,
          outgoing: original.outgoing,
        }
        return { message: post(chatOf(toChatId), original.text, { forwardedFrom }), sendId }
      }).message,
    delete: async (chatId, messageIds) => {
      for (const id of messageIds) messageOf(chatId, id)
      state.messages = state.messages.filter((message) => message.chatId !== chatId || !messageIds.includes(message.id))
    },

    pin: async (chatId, messageId) => {
      messageOf(chatId, messageId)
      pins.set(chatId, messageId)
    },
    unpin: async (chatId, messageId) => {
      if (pins.get(chatId) === messageId) pins.delete(chatId)
    },
    react: async (chatId, messageId, emoji) => {
      messageOf(chatId, messageId).reactions =
        emoji === null ? null : { counts: [{ reaction: emoji, count: 1 }], mine: emoji, total: 1 }
    },
    markRead: async (chatId) => {
      chatOf(chatId).unreadCount = 0
    },

    markTopicRead: async (chatId) => {
      chatOf(chatId)
    },

    poll: async (chatId, messageId) => ({ ...pollOf(chatId, messageId) }),
    vote: async (chatId, messageId, answerIds) => {
      const poll = pollOf(chatId, messageId)
      const unknown = answerIds.find((id) => !poll.answers.some((answer) => answer.id === id))
      if (unknown !== undefined) throw new CliError("validation_error", `the poll has no answer ${unknown}`)
      for (const answer of poll.answers) answer.chosen = answerIds.includes(answer.id)
      return { ...poll }
    },
    closePoll: async (chatId, messageId) => {
      const poll = pollOf(chatId, messageId)
      poll.closed = true
      return { ...poll }
    },
    createPoll: async (chatId, poll, { sendId }) =>
      once(sendId, () => {
        const sent = post(chatOf(chatId), poll.question)
        polls.set(`${chatId}/${sent.id}`, {
          chatId,
          messageId: sent.id,
          question: poll.question,
          answers: poll.answers.map((text, index) => ({ id: String(index), text, voters: null, chosen: false })),
          closed: false,
          multiple: poll.multiple,
          anonymous: poll.anonymous,
          voters: null,
        })
        return { message: sent, sendId }
      }),

    watch: async (onEvent, signal, onReady) => {
      if (signal.aborted) return
      listeners.add(onEvent)
      onReady?.()
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      listeners.delete(onEvent)
    },

    ...(options.feed
      ? {
          feed: async (onBatch: (batch: HistoryBatch) => void, signal: AbortSignal) => {
            if (signal.aborted) return
            onBatch({ chats: structuredClone(state.chats), people: state.people.map(asMember) })
            for (const chat of state.chats) {
              const messages = messagesOf(chat.id)
              if (messages.length > 0) onBatch({ messages: structuredClone(messages) })
            }
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
          },
        }
      : {}),

    download: async (reference, messageId) => {
      const message = messageOf(chatOf(reference).id, messageId)
      return {
        files: message.attachments.map((attachment) => ({
          kind: attachment.kind,
          ...(attachment.name === undefined ? {} : { name: attachment.name }),
          bytes: async function* () {},
        })),
        skipped: [],
      }
    },
    transcribe: async (reference, messageId) => {
      const message = messageOf(chatOf(reference).id, messageId)
      if (!message.attachments.some((attachment) => attachment.kind === "voice"))
        throw new CliError("validation_error", `message ${messageId} is not a voice message`)
      return { text: message.text, pending: false }
    },
    scheduled: async (reference) => {
      const chat = chatOf(reference)
      return structuredClone(scheduled.filter((message) => message.chatId === chat.id))
    },

    members: async (reference, window) => {
      const chat = chatOf(reference)
      const ruling = admins.get(chat.id) ?? []
      const all: GroupMember[] = (state.members[chat.id] ?? []).map((member) => ({
        ...member,
        role: ruling.includes(member.id) ? "admin" : "member",
      }))
      return { ...page(all, window), chatId: chat.id }
    },
    admins: async (reference) => [...(admins.get(chatOf(reference).id) ?? [])],
    chatEvents: async (reference, { since }) => ({
      chatId: chatOf(reference).id,
      since: new Date(since).toISOString(),
      events: [],
      more: false,
    }),

    sessions: async () => [{ ...THIS_SESSION }],
    lookup: async () => {
      throw missing("person with that phone number")
    },
    addressBook: async () => state.people.filter((person) => contacts.has(person.id)).map(asMember),

    people: async (references) => references.map((reference) => personOf(reference).id),
    createGroup: async (title, people, { channel }) => {
      const chat: Chat = {
        id: nextId("chat"),
        title,
        kind: channel ? "channel" : "group",
        unreadCount: 0,
        lastMessageAt: null,
        participantsCount: people.length + 1,
      }
      state.chats.unshift(chat)
      state.members[chat.id] = [ownId(), ...people].map((id) => ({
        id,
        name: state.people.find((person) => person.id === id)?.name ?? null,
        username: null,
      }))
      return cardOf(chat)
    },
    join: async (link) => {
      throw missing(`chat behind ${link}`)
    },
    leave: async (reference) => {
      const chat = chatOf(reference)
      chat.membershipState = "left"
      return { chatId: chat.id }
    },
    group: async (reference) => cardOf(chatOf(reference)),
    updateGroup: async (chatId, change) => {
      const chat = chatOf(chatId)
      const group = groupOf(chat.id)
      if (change.title !== undefined) chat.title = change.title
      if (change.description !== undefined) group.description = change.description
      Object.assign(group.settings, change.settings)
      return cardOf(chat)
    },
    resetInviteLink: async (chatId) => {
      const chat = chatOf(chatId)
      groupOf(chat.id).link = `https://example.invalid/join/${nextId("link")}`
      return cardOf(chat)
    },
    addMembers: async (chatId, people) => {
      const list = state.members[chatOf(chatId).id] ?? []
      for (const id of people) if (!list.some((member) => member.id === id)) list.push(asMember(personOf(id)))
      state.members[chatId] = list
      return { notAdded: [] }
    },
    removeMembers: async (chatId, people) => {
      state.members[chatId] = (state.members[chatOf(chatId).id] ?? []).filter((member) => !people.includes(member.id))
    },
    addAdmin: async (chatId, person) => {
      const list = admins.get(chatOf(chatId).id) ?? []
      admins.set(chatId, [...new Set([...list, person])])
    },
    removeAdmin: async (chatId, person) => {
      admins.set(
        chatId,
        (admins.get(chatOf(chatId).id) ?? []).filter((id) => id !== person),
      )
    },

    folders: async () => structuredClone(folders),
    createFolder: async (title, chatIds, rules = {}) => {
      const folder: Folder = { id: nextId("folder"), title, chatIds: [...chatIds] }
      withRules(folder, rules)
      folders.push(folder)
      return { ...folder }
    },
    updateFolder: async (folderId, change) => {
      const folder = folderOf(folderId)
      if (change.title !== undefined) folder.title = change.title
      const kept = (ids: Id[] = []) => ids.filter((id) => !change.remove?.includes(id))
      folder.chatIds = kept([...new Set([...folder.chatIds, ...(change.add ?? [])])])
      withRules(folder, change)
      if (folder.excludedChatIds) folder.excludedChatIds = kept(folder.excludedChatIds)
      if (folder.pinnedChatIds) folder.pinnedChatIds = kept(folder.pinnedChatIds)
      return { ...folder }
    },
    deleteFolder: async (folderId) => {
      folders.splice(folders.indexOf(folderOf(folderId)), 1)
    },
    orderFolders: async (folderIds) => {
      const ordered = folderIds.map(folderOf)
      folders.splice(0, folders.length, ...ordered)
    },
    joinFolder: async (link) => {
      const folder = { id: nextId("folder"), title: link.split("/").pop() ?? link, chatIds: [] }
      folders.push(folder)
      return { ...folder }
    },

    addContact: async (personId) => {
      const person = personOf(personId)
      contacts.add(person.id)
      return asMember(person)
    },
    removeContact: async (personId) => {
      contacts.delete(personOf(personId).id)
    },
    block: async (personId) => {
      blocked.add(personOf(personId).id)
    },
    unblock: async (personId) => {
      blocked.delete(personId)
    },
    renameContact: async (personId, firstName, lastName) => {
      const person = personOf(personId)
      person.name = [firstName, lastName].filter(Boolean).join(" ")
      return asMember(person)
    },
    importContacts: async (entries) =>
      entries.flatMap(({ name }) => {
        const person = state.people.find((one) => one.name === name)
        if (!person) return []
        contacts.add(person.id)
        return [asMember(person)]
      }),

    updateProfile: async (change) => {
      const current = { ...(account as Account), id: ownId() }
      const name = [change.firstName, change.lastName].filter(Boolean).join(" ")
      account = { ...current, ...(name ? { name } : {}) }
      return { ...account }
    },
    endOtherSessions: async () => [{ ...THIS_SESSION }],
  }
}
