import { CliError } from "@wirecat/cli-base"
import type { Chat, ChatEvent, Id, Message, MessageEvent, PollVote } from "../../domain/models.js"
import { capability, type HistoryBatch, type MessengerAdapter, throughWrapper } from "../../ports/messenger.js"
import type { MessengerTraits } from "../../ports/traits.js"
import { isId, type PeopleLookup, pickPerson } from "../../resolve.js"
import type { EventSink } from "../../runs/events.js"
import { codeOf } from "../../sends/guarded.js"
import { chatIdIn } from "../../services/message-resolution.js"
import type { AccountKey, DeletionScope, IngestedVia, MessageStore } from "../../store/store.js"

const REKEY_LOCK_MS = 50
const REKEY_PAUSE_MS = 25

export interface Saving {
  account: AccountKey
  /** Opened on the first save, not before: a command that reads nothing has no reason to touch the file. */
  store: () => Promise<MessageStore | undefined>
  warn: (message: string) => void
  events: EventSink
  /** Saves still writing, for the closer to wait on: `watch` does not hold the next event for one. */
  pending?: Set<Promise<void>>
  /** `storedChats` calls still running, apart from `pending`: one abandoned at exit leaves nothing unsaved. */
  announcing?: Set<Promise<void>>
  deletedWithoutChat?: DeletionScope
  /** The app command and profile running, recorded with the first save so another app can name this account. */
  profile?: { app: string; name: string }
  /** After a re-key is saved: what outside the store spells the chat id follows it. */
  rekeyed?: (from: Id, to: Id) => void | Promise<void>
  /**
   * Chat and partner ids this account's recipient list names, told to `storedChats` apart from the stored ones: an
   * entry saved before any chat was stored under its id would otherwise never be re-keyed, and the send guard would
   * refuse it.
   */
  recipientIds?: () => Id[]
  /**
   * Set for a messenger whose history is pushed into the store (`history: "store"`): chat and person names, and the
   * titles `watch` leaves out, are answered from the store first. Its server has no directory to ask.
   */
  namesFromStore?: Pick<MessengerTraits, "savedChatId">
}

/**
 * The adapter, with what each read answers written to the store. **A failed write never fails the
 * read** — the answer is already here, and it is what was asked for.
 *
 * `resolve` is not saved: a chat found by name has no unread count or last message, and writing it
 * would erase what `chats list` stored. Nor are `chat` and `contact`: a card's member list is not
 * known to be whole, and `saveMembers` replaces the list.
 */
export const stored = (
  messenger: MessengerAdapter,
  {
    account,
    store,
    warn,
    events,
    pending,
    announcing,
    deletedWithoutChat,
    profile,
    rekeyed,
    namesFromStore,
    recipientIds,
  }: Saving,
): MessengerAdapter => {
  let warned = false
  let recorded = profile === undefined
  const notWritten = (operation: string, error: unknown): void => {
    events({ event: "warning", code: "store_not_written", operation })
    if (!warned) warn(`not saved to the local store: ${error instanceof Error ? error.message : String(error)}`)
    warned = true
  }
  const attempt = async (operation: string, write: (store: MessageStore) => Promise<unknown>): Promise<void> => {
    try {
      const opened = await store()
      if (opened) await write(opened)
      // After the write, so saves keep their order; a convenience for naming this account from another app.
      if (opened && !recorded && profile) {
        recorded = true
        await Promise.resolve()
          .then(() => opened.accounts.saveProfile(profile.app, profile.name, account))
          .catch(() => {})
      }
    } catch (error) {
      notWritten(operation, error)
    }
  }
  const save = (operation: string, writing: (store: MessageStore) => Promise<unknown>): Promise<void> => {
    const saving = attempt(operation, writing)
    pending?.add(saving)
    return saving.finally(() => pending?.delete(saving))
  }

  const { chats, history, around, people } = messenger
  /**
   * A chat stored under an id the messenger no longer names it by (WhatsApp: a phone-form chat whose LID it now knows)
   * would take every write by that id, while what the messenger answers lands under the new one. So a stored id still
   * goes to the messenger, and an answer under another id re-keys the chat: a one-shot command closes the split too.
   */
  const followed = async (opened: MessageStore, scoped: AccountKey, held: Chat): Promise<Chat | undefined> => {
    let answered: Chat
    try {
      answered = await messenger.resolve(held.id)
    } catch (error) {
      if (codeOf(error) === "not_found") return undefined
      throw error
    }
    if (answered.id === held.id) return undefined
    await attempt("history.rekey", async (store) => {
      await store.chats.rekeyChat(scoped, held.id, answered.id)
      await rekeyed?.(held.id, answered.id)
    })
    return (await storedChat(opened, scoped, namesFromStore ?? {}, answered.id)).held ?? answered
  }
  const titles = new Map<Id, string>()
  const storedPeople = async (): Promise<PeopleLookup | undefined> => {
    try {
      return await (await store())?.people.people(account.provider, { account: account.account })
    } catch {
      return undefined
    }
  }
  /**
   * The first serve after an upgrade re-keys every phone-form chat at once. Back-to-back transactions keep the write
   * lock so busy that another command waits past `busy_timeout`, so the re-keys go in passes with a pause between.
   */
  const saveRekeys = async (pairs: readonly { from: Id; to: Id }[]): Promise<void> => {
    let rest = pairs
    while (rest.length > 0) {
      // A pass that failed whole rolled back: only its first pair is given up, as when each re-key was its own write.
      let taken = 1
      let held = false
      await attempt("history.rekey", async (opened) => {
        const pass = await opened.chats.rekeyChats(account, rest, REKEY_LOCK_MS)
        taken = pass.taken
        held = true
        for (const { from, to } of pass.applied)
          await Promise.resolve()
            .then(() => rekeyed?.(from, to))
            .catch((error: unknown) => notWritten("history.rekey", error))
        for (const { error } of pass.refused) notWritten("history.rekey", error)
      })
      rest = rest.slice(taken)
      if (held && rest.length > 0) await new Promise((resolve) => setTimeout(resolve, REKEY_PAUSE_MS))
    }
  }
  const saveBatches = (operation: string, onBatch: (batch: HistoryBatch) => void) => {
    // In order: a batch's messages may belong to chats only an earlier batch named.
    let previous: Promise<void> = Promise.resolve()
    return (batch: HistoryBatch) => {
      if (namesFromStore) {
        for (const { from, to } of batch.rekeys ?? []) {
          const title = titles.get(from)
          titles.delete(from)
          if (title && !titles.has(to)) titles.set(to, title)
        }
        for (const chat of batch.chats ?? []) if (chat.title) titles.set(chat.id, chat.title)
      }
      // A refused re-key leaves its chat split, never the others or the batch's history unsaved.
      const saving = previous.then(async () => {
        await saveRekeys(batch.rekeys ?? [])
        await attempt(operation, (opened) => fill(opened, account, batch))
      })
      previous = saving
      pending?.add(saving)
      void saving.finally(() => pending?.delete(saving))
      onBatch(batch)
    }
  }
  // A method not listed here saves nothing and passes through; a lane that should save adds its line.
  return throughWrapper(messenger, {
    ...(messenger.forumState
      ? {
          forumState: async (chatId: string) => {
            const state = await capability(messenger, "forumState", "read forum settings")(chatId)
            await save("forum.read", (opened) => opened.chats.saveChats(account, [state.chat]))
            return state
          },
        }
      : {}),
    ...(messenger.upgradeForum
      ? {
          upgradeForum: async (chatId: string) => {
            const state = await capability(messenger, "upgradeForum", "upgrade a group")(chatId)
            await save("forum.upgrade", (opened) => opened.chats.saveChats(account, [state.chat]))
            return state
          },
        }
      : {}),
    ...(messenger.enableForum
      ? {
          enableForum: async (chatId: string) => {
            const state = await capability(messenger, "enableForum", "enable forum topics")(chatId)
            await save("forum.enable", (opened) => opened.chats.saveChats(account, [state.chat]))
            return state
          },
        }
      : {}),
    self: () => messenger.self(),
    resolve: async (reference) => {
      if (isId(reference) && !namesFromStore) return messenger.resolve(reference)
      let accountId: string
      try {
        accountId = account.account
      } catch {
        return messenger.resolve(reference)
      }
      const scoped = { provider: account.provider, account: accountId }
      const opened = await store().catch(() => undefined)
      if (!opened) return messenger.resolve(reference)
      const { id, held } = namesFromStore ? await storedChat(opened, scoped, namesFromStore, reference) : {}
      if (!isId(reference)) {
        const people = await opened.people.people(scoped.provider, { account: scoped.account })
        const wanted = reference.trim().toLowerCase()
        if (people.all().some((person) => person.alias?.toLowerCase().includes(wanted))) {
          const person = pickPerson(reference, people)
          const chats = (await opened.chats.chatsWith(scoped, person.id)).filter((chat) => chat.kind === "dialog")
          if (chats.length !== 1 || !chats[0])
            throw new CliError("validation_error", "the alias has no unique stored direct chat; use a chat id")
          let remote: Awaited<ReturnType<MessengerAdapter["resolve"]>> | undefined
          if (namesFromStore) remote = held
          else
            try {
              remote = await messenger.resolve(reference)
            } catch (error) {
              if (!(error instanceof CliError) || error.code !== "not_found") throw error
            }
          if (remote && remote.id !== chats[0].id)
            throw new CliError("validation_error", "the local alias also names another messenger chat; use a chat id", {
              candidates: [{ id: chats[0].id }, { id: remote.id }],
            })
          return remote ?? (namesFromStore ? chats[0] : messenger.resolve(chats[0].id))
        }
      }
      if (held && held.id === reference.trim()) return (await followed(opened, scoped, held)) ?? held
      return held ?? messenger.resolve(id ?? reference)
    },
    chat: (reference) => messenger.chat(reference),
    ...(people && namesFromStore
      ? {
          people: async (references: string[]) => {
            const known = await storedPeople()
            const found = references.map((reference) => (known ? personIn(known, reference) : undefined))
            const asked = references.filter((_, at) => found[at] === undefined)
            const answered = asked.length === 0 ? [] : await people.call(messenger, asked)
            const ids: Id[] = []
            for (const id of found) {
              const one = id ?? answered.shift()
              if (one === undefined)
                throw new CliError("not_found", "the messenger found fewer people than it was asked")
              ids.push(one)
            }
            return ids
          },
        }
      : {}),
    logout: () => messenger.logout(),
    close: () => messenger.close(),
    me: async () => {
      const me = await messenger.me()
      await save("account.me", (opened) => opened.accounts.saveAccount(account, { name: me.name }))
      return me
    },
    ...(chats
      ? {
          chats: async (window) => {
            const page = await chats.call(messenger, window)
            // Only a page that names every chat says the others were left; an empty one is a hiccup.
            const complete = window.offset === 0 && !page.hasMore && page.items.length > 0
            await save("chats.list", async (opened) => {
              await opened.chats.saveChats(account, page.items)
              const ids = page.items.map((chat) => chat.id)
              if (complete) await opened.chats.markChatsLeft(account, ids)
              else await opened.chats.rejoinChats(account, ids)
            })
            return page
          },
        }
      : {}),
    ...(history
      ? {
          history: async (reference, options) => {
            const seenAt = Date.now()
            const page = await history.call(messenger, reference, options)
            const chatId = page.items[0]?.chatId
            if (chatId !== undefined) {
              await save("messages.list", (opened) =>
                opened.messages.saveMessages(account, chatId, page.items, { via: "history", seenAt }),
              )
            }
            return page
          },
        }
      : {}),
    ...(around
      ? {
          around: async (reference, messageId, window) => {
            const seenAt = Date.now()
            const items = await around.call(messenger, reference, messageId, window)
            const chatId = items[0]?.chatId
            if (chatId !== undefined) {
              const plain = items.map(({ anchor, ...message }) => message)
              await save("messages.around", (opened) =>
                opened.messages.saveMessages(account, chatId, plain, { via: "context", seenAt }),
              )
            }
            return items
          },
        }
      : {}),
    ...(messenger.watch
      ? {
          watch: async (onEvent, signal, onReady) => {
            if (namesFromStore) await rememberTitles(store, account, titles)
            return (
              messenger.watch?.(
                (event) => {
                  const seenAt = Date.now()
                  void save("messages.watch", (opened) => keep(opened, account, event, seenAt, deletedWithoutChat))
                  onEvent(namesFromStore ? titled(event, titles) : event)
                },
                signal,
                onReady,
              ) ?? Promise.resolve()
            )
          },
        }
      : {}),
    ...(messenger.listen
      ? {
          listen: (onEvent, signal) =>
            messenger.listen?.((event) => {
              void save("messages.listen", (opened) => keep(opened, account, event, Date.now(), deletedWithoutChat))
              onEvent(event)
            }, signal) ?? Promise.resolve(),
        }
      : {}),
    ...(messenger.feed
      ? {
          feed: (onBatch, signal) => {
            if (messenger.storedChats) {
              const announced = announceStoredChats(messenger, store, account, events, warn, recipientIds)
              announcing?.add(announced)
              void announced.finally(() => announcing?.delete(announced))
            }
            return messenger.feed?.(saveBatches("history.feed", onBatch), signal) ?? Promise.resolve()
          },
        }
      : {}),
    ...(messenger.listenHistory
      ? {
          listenHistory: (onBatch, signal) =>
            messenger.listenHistory?.(saveBatches("history.listen", onBatch), signal) ?? Promise.resolve(),
        }
      : {}),
    ...(messenger.edit
      ? {
          edit: async (chatId, messageId, text, options) => {
            const seenAt = Date.now()
            const edited = await capability(messenger, "edit", "edit")(chatId, messageId, text, options)
            await save("messages.edit", async (opened) => {
              const held = (await opened.messages.message(account, messageId, { chatId })) !== undefined
              await saveSent(opened, account, chatId, edited, { via: "update", seenAt }, held ? chatId : undefined)
            })
            return edited
          },
        }
      : {}),
    ...(messenger.createPoll
      ? {
          // A messenger that never echoes a device's own message back would otherwise never hold the poll.
          createPoll: async (chatId, poll, options) => {
            const sent = await capability(messenger, "createPoll", "create a poll")(chatId, poll, options)
            await save("polls.create", (opened) => saveSent(opened, account, chatId, sent.message, { via: "send" }))
            return sent
          },
        }
      : {}),
    ...(messenger.vote
      ? {
          vote: async (chatId, messageId, answerIds) => {
            const poll = await capability(messenger, "vote", "vote in a poll")(chatId, messageId, answerIds)
            const votedAt = new Date().toISOString()
            await save("polls.vote", (opened) =>
              opened.messages.saveVote(account, chatId, messageId, {
                person: { id: account.account, name: null, username: null },
                answers: answerIds,
                votedAt,
              }),
            )
            return poll
          },
        }
      : {}),
    ...(messenger.star
      ? {
          // The messenger may not echo the owner's own star back, and `messages list starred:true` reads the store.
          star: async (chatId, messageId, starred) => {
            await capability(messenger, "star", "star a message")(chatId, messageId, starred)
            await save("messages.star", (opened) => opened.messages.saveStar(account, chatId, messageId, starred))
          },
        }
      : {}),
    ...(messenger.forward
      ? {
          forward: async (fromChatId, messageId, toChatId, options) => {
            const copy = await capability(messenger, "forward", "forward")(fromChatId, messageId, toChatId, options)
            await save("messages.forward", (opened) => saveSent(opened, account, toChatId, copy, { via: "send" }))
            return copy
          },
        }
      : {}),
    // Without this, a message deleted here would still be found by `search messages` and read `--offline`.
    ...(messenger.delete
      ? {
          delete: async (chatId, messageIds, options) => {
            await capability(messenger, "delete", "delete")(chatId, messageIds, options)
            await save("messages.delete", (opened) => opened.messages.markDeleted(account, messageIds, { chatId }))
          },
        }
      : {}),
    send: async (chatId, text, options) => {
      const sent = await messenger.send(chatId, text, options)
      // A scheduled message is not in the chat yet, and it will arrive under another id.
      if (options.at === undefined) {
        await save("messages.send", (opened) => saveSent(opened, account, chatId, sent.message, { via: "send" }))
      }
      return sent
    },
  })
}

/**
 * A write is saved under the chat the messenger answered, not the one typed: WhatsApp answers a re-keyed person's
 * phone-form id with the LID chat, and saving under the typed id would split the chat until the next re-key.
 * `into` overrides it for an edit, whose message stays in the row that already holds it.
 */
const saveSent = (
  opened: MessageStore,
  account: AccountKey,
  typed: Id,
  message: Message,
  options: { via: IngestedVia; seenAt?: number },
  into: Id = message.chatId || typed,
): Promise<void> => opened.messages.saveMessages(account, into, [message], { ...options, typedChatId: typed })

/**
 * The chat id a name or id names, as the store reads it, and the stored chat when there is one. Neither when the
 * store knows no such name; an error when several stored chats match it.
 */
const storedChat = async (
  store: MessageStore,
  account: AccountKey,
  traits: Pick<MessengerTraits, "savedChatId">,
  reference: string,
): Promise<{ id?: Id; held?: Chat }> => {
  const bound = store.forAccount(account)
  const id = await chatIdIn(traits, reference, bound).catch((error: unknown) => {
    if (codeOf(error) === "not_found") return undefined
    throw error
  })
  if (id === undefined) return {}
  const held = (await bound.chats.chats({})).items.find((chat) => chat.id === id)
  return held ? { id, held } : { id }
}

const personIn = (people: PeopleLookup, reference: string): Id | undefined => {
  try {
    return pickPerson(reference, people).id
  } catch (error) {
    if (codeOf(error) === "not_found") return undefined
    throw error
  }
}

const announceStoredChats = async (
  messenger: MessengerAdapter,
  store: Saving["store"],
  account: AccountKey,
  events: EventSink,
  warn: (message: string) => void,
  recipientIds: Saving["recipientIds"],
): Promise<void> => {
  let listed: Id[] = []
  try {
    listed = recipientIds?.() ?? []
  } catch (error) {
    warn(`the messenger was not told the recipient list: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const opened = await store()
    const held = opened ? (await opened.forAccount(account).chats.chats({})).items.map((chat) => chat.id) : []
    const recipients = [...new Set(listed)].filter((id) => !held.includes(id))
    if (recipients.length > 0) await messenger.storedChats?.(held, recipients)
    else if (opened) await messenger.storedChats?.(held)
  } catch (error) {
    events({ event: "warning", code: "stored_chats_failed", operation: "history.stored_chats" })
    warn(`the messenger was not told the stored chats: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read once when `watch` starts: a store read per event would let a later event overtake an earlier one. */
const rememberTitles = async (store: Saving["store"], account: AccountKey, titles: Map<Id, string>): Promise<void> => {
  try {
    const opened = await store()
    for (const chat of (await opened?.forAccount(account).chats.chats({}))?.items ?? [])
      if (chat.title && !titles.has(chat.id)) titles.set(chat.id, chat.title)
  } catch {}
}

const titled = (event: MessageEvent, titles: Map<Id, string>): MessageEvent => {
  if (event.event === "message" || event.event === "edit") {
    const title = event.message.chatTitle ?? titles.get(event.message.chatId)
    return title ? { ...event, message: { ...event.message, chatTitle: title } } : event
  }
  if (event.event === "chat_event" && event.change.event === "title" && event.change.title)
    titles.set(event.chatId, event.change.title)
  if (event.chatTitle !== null || event.chatId === null) return event
  const title = titles.get(event.chatId)
  return title ? { ...event, chatTitle: title } : event
}

/**
 * A pushed batch as the store keeps it. No `markChatsLeft`: a push names some chats, never all of them.
 * No `seenAt`: a pushed snapshot may be older than a deletion this store already holds. A chat's votes and stars go
 * in the transaction of its messages, after them, so a message in the batch is held, or known deleted, before them.
 */
const fill = async (store: MessageStore, account: AccountKey, batch: HistoryBatch): Promise<void> => {
  if (batch.chats?.length) await store.chats.saveChats(account, batch.chats)
  if (batch.people?.length) await store.people.savePeople(account, batch.people)
  const byChat = new Map<
    Id,
    { messages: Message[]; votes: { messageId: Id; vote: PollVote }[]; stars: { messageId: Id; starred: boolean }[] }
  >()
  const of = (chatId: Id) => {
    const held = byChat.get(chatId) ?? { messages: [], votes: [], stars: [] }
    byChat.set(chatId, held)
    return held
  }
  for (const message of batch.messages ?? []) of(message.chatId).messages.push(message)
  for (const { chatId, messageId, vote } of batch.votes ?? []) of(chatId).votes.push({ messageId, vote })
  for (const { chatId, messageId, starred } of batch.stars ?? []) of(chatId).stars.push({ messageId, starred })
  for (const [chatId, { messages, votes, stars }] of byChat)
    await store.messages.saveMessages(account, chatId, messages, { via: "history", votes, stars })
  const changes = new Map<Id, ChatEvent[]>()
  for (const { chatId, change } of batch.events ?? []) changes.set(chatId, [...(changes.get(chatId) ?? []), change])
  for (const [chatId, events] of changes) await store.roster.saveChatEvents(account, chatId, events)
}

/**
 * Each change as the store keeps it: a message or an edit upserted, a deletion a tombstone, reactions replaced, a
 * voter's vote replacing their older one, a star set or taken off, a chat event kept once.
 */
const keep = async (
  store: MessageStore,
  account: AccountKey,
  event: MessageEvent,
  seenAt: number,
  among: DeletionScope | undefined,
): Promise<void> => {
  switch (event.event) {
    case "message":
    case "edit": {
      const { chatTitle, ...message } = event.message
      await store.messages.saveMessages(account, message.chatId, [message], { via: "update", seenAt })
      return
    }
    case "delete":
      await store.messages.markDeleted(
        account,
        [event.messageId],
        event.chatId === null ? (among ? { among } : {}) : { chatId: event.chatId },
      )
      return
    case "vote":
      await store.messages.saveVote(account, event.chatId, event.messageId, event.vote)
      return
    case "star":
      await store.messages.saveStar(account, event.chatId, event.messageId, event.starred)
      return
    case "chat_event":
      await store.roster.saveChatEvents(account, event.chatId, [event.change])
      return
    case "reaction":
      await store.messages.saveReactions(
        account,
        event.chatId,
        event.messageId,
        event.reactions,
        event.counterObservation ? { observation: event.counterObservation } : {},
      )
  }
}
