import { CliError } from "@wirecat/cli-base"
import type { Id, Message, MessageEvent, PollVote } from "../../domain/models.js"
import { capability, type HistoryBatch, type MessengerAdapter, throughWrapper } from "../../ports/messenger.js"
import { isId, pickPerson } from "../../resolve.js"
import type { EventSink } from "../../runs/events.js"
import type { AccountKey, DeletionScope, MessageStore } from "../../store/store.js"

export interface Saving {
  account: AccountKey
  /** Opened on the first save, not before: a command that reads nothing has no reason to touch the file. */
  store: () => Promise<MessageStore | undefined>
  warn: (message: string) => void
  events: EventSink
  /** Saves still writing, for the closer to wait on: `watch` does not hold the next event for one. */
  pending?: Set<Promise<void>>
  deletedWithoutChat?: DeletionScope
  /** The app command and profile running, recorded with the first save so another app can name this account. */
  profile?: { app: string; name: string }
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
  { account, store, warn, events, pending, deletedWithoutChat, profile }: Saving,
): MessengerAdapter => {
  let warned = false
  let recorded = profile === undefined
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
      events({ event: "warning", code: "store_not_written", operation })
      if (!warned) warn(`not saved to the local store: ${error instanceof Error ? error.message : String(error)}`)
      warned = true
    }
  }
  const save = (operation: string, writing: (store: MessageStore) => Promise<unknown>): Promise<void> => {
    const saving = attempt(operation, writing)
    pending?.add(saving)
    return saving.finally(() => pending?.delete(saving))
  }

  const { chats, history, around } = messenger
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
      if (isId(reference)) return messenger.resolve(reference)
      let accountId: string
      try {
        accountId = account.account
      } catch {
        return messenger.resolve(reference)
      }
      const scoped = { provider: account.provider, account: accountId }
      const opened = await store().catch(() => undefined)
      if (opened) {
        const people = await opened.people.people(scoped.provider, { account: scoped.account })
        const wanted = reference.trim().toLowerCase()
        if (people.all().some((person) => person.alias?.toLowerCase().includes(wanted))) {
          const person = pickPerson(reference, people)
          const chats = (await opened.chats.chatsWith(scoped, person.id)).filter((chat) => chat.kind === "dialog")
          if (chats.length !== 1 || !chats[0])
            throw new CliError("validation_error", "the alias has no unique stored direct chat; use a chat id")
          let remote: Awaited<ReturnType<MessengerAdapter["resolve"]>> | undefined
          try {
            remote = await messenger.resolve(reference)
          } catch (error) {
            if (!(error instanceof CliError) || error.code !== "not_found") throw error
          }
          if (remote && remote.id !== chats[0].id)
            throw new CliError("validation_error", "the local alias also names another messenger chat; use a chat id", {
              candidates: [{ id: chats[0].id }, { id: remote.id }],
            })
          return remote ?? messenger.resolve(chats[0].id)
        }
      }
      return messenger.resolve(reference)
    },
    chat: (reference) => messenger.chat(reference),
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
              if (complete)
                await opened.chats.markChatsLeft(
                  account,
                  page.items.map((chat) => chat.id),
                )
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
          watch: (onEvent, signal, onReady) =>
            messenger.watch?.(
              (event) => {
                const seenAt = Date.now()
                void save("messages.watch", (opened) => keep(opened, account, event, seenAt, deletedWithoutChat))
                onEvent(event)
              },
              signal,
              onReady,
            ) ?? Promise.resolve(),
        }
      : {}),
    ...(messenger.feed
      ? {
          feed: (onBatch, signal) => {
            // In order: a batch's messages may belong to chats only an earlier batch named.
            let previous: Promise<void> = Promise.resolve()
            return (
              messenger.feed?.((batch) => {
                const saving = previous.then(() => attempt("history.feed", (opened) => fill(opened, account, batch)))
                previous = saving
                pending?.add(saving)
                void saving.finally(() => pending?.delete(saving))
                onBatch(batch)
              }, signal) ?? Promise.resolve()
            )
          },
        }
      : {}),
    ...(messenger.edit
      ? {
          edit: async (chatId, messageId, text, options) => {
            const seenAt = Date.now()
            const edited = await capability(messenger, "edit", "edit")(chatId, messageId, text, options)
            await save("messages.edit", (opened) =>
              opened.messages.saveMessages(account, chatId, [edited], { via: "update", seenAt }),
            )
            return edited
          },
        }
      : {}),
    ...(messenger.createPoll
      ? {
          // A messenger that never echoes a device's own message back would otherwise never hold the poll.
          createPoll: async (chatId, poll, options) => {
            const sent = await capability(messenger, "createPoll", "create a poll")(chatId, poll, options)
            await save("polls.create", (opened) =>
              opened.messages.saveMessages(account, chatId, [sent.message], { via: "send" }),
            )
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
    ...(messenger.forward
      ? {
          forward: async (fromChatId, messageId, toChatId, options) => {
            const copy = await capability(messenger, "forward", "forward")(fromChatId, messageId, toChatId, options)
            await save("messages.forward", (opened) =>
              opened.messages.saveMessages(account, toChatId, [copy], { via: "send" }),
            )
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
        await save("messages.send", (opened) =>
          opened.messages.saveMessages(account, chatId, [sent.message], { via: "send" }),
        )
      }
      return sent
    },
  })
}

/**
 * A pushed batch as the store keeps it. No `markChatsLeft`: a push names some chats, never all of them.
 * No `seenAt`: a pushed snapshot may be older than a deletion this store already holds. A chat's votes go in the
 * transaction of its messages, after them, so a poll in the batch is held, or known deleted, before its votes.
 */
const fill = async (store: MessageStore, account: AccountKey, batch: HistoryBatch): Promise<void> => {
  if (batch.chats?.length) await store.chats.saveChats(account, batch.chats)
  if (batch.people?.length) await store.people.savePeople(account, batch.people)
  const byChat = new Map<Id, { messages: Message[]; votes: { messageId: Id; vote: PollVote }[] }>()
  const of = (chatId: Id) => {
    const held = byChat.get(chatId) ?? { messages: [], votes: [] }
    byChat.set(chatId, held)
    return held
  }
  for (const message of batch.messages ?? []) of(message.chatId).messages.push(message)
  for (const { chatId, messageId, vote } of batch.votes ?? []) of(chatId).votes.push({ messageId, vote })
  for (const [chatId, { messages, votes }] of byChat)
    await store.messages.saveMessages(account, chatId, messages, { via: "history", votes })
}

/**
 * Each change as the store keeps it: a message or an edit upserted, a deletion a tombstone, reactions replaced, a
 * voter's vote replacing their older one.
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
