import type { MessageEvent } from "../../domain/models.js"
import { isCliFailure } from "../../errors/failures.js"
import { type HistoryBatch, type MessengerAdapter, throughWrapper } from "../../ports/messenger.js"
import { type EventSink, providerErrorKey } from "../../runs/events.js"
import { currentOperation } from "../../sends/guarded.js"

type Named = { ids?: Record<string, string>; counts?: Record<string, number> }

/**
 * The adapter, with a request and a response event around each call. **Ids come from arguments
 * that already are ids, or from the answer — never from a typed chat**, which is often a title.
 */
export const observed = (messenger: MessengerAdapter, events: EventSink): MessengerAdapter => {
  const timed = async <T>(operation: string, named: Named, work: () => Promise<T>, after?: (answer: T) => Named) => {
    const write = currentOperation()
    const marked = (part: Named = {}): Named =>
      write === undefined ? part : { ...part, ids: { ...part.ids, operation: write } }
    events({ event: "request", operation, level: "operation", ...marked(named) })
    const started = performance.now()
    const durationMs = () => Math.round(performance.now() - started)
    try {
      const answer = await work()
      events({
        event: "response",
        operation,
        level: "operation",
        durationMs: durationMs(),
        outcome: "ok",
        ...marked(after?.(answer)),
      })
      return answer
    } catch (error) {
      const providerError = isCliFailure(error) ? providerErrorKey(error.details?.provider_error) : undefined
      events({
        event: "response",
        operation,
        level: "operation",
        durationMs: durationMs(),
        outcome: "error",
        errorCode: isCliFailure(error) ? error.code : "generic_failure",
        ...(providerError ? { providerError } : {}),
        ...marked(),
      })
      throw error
    }
  }

  const counted = async <T>(
    operation: string,
    onItem: (item: T) => void,
    work: (onItem: (item: T) => void) => Promise<void>,
    count: (item: T, counts: Record<string, number>) => void,
  ) => {
    const counts: Record<string, number> = {}
    await timed(
      operation,
      {},
      () =>
        work((item) => {
          count(item, counts)
          onItem(item)
        }),
      () => ({ counts }),
    )
  }

  const mint = messenger.newSendId
  const { chats, history, contact, around, watch, feed, listen, listenHistory } = messenger
  // A method not listed here is timed under its own name, with no ids until a line here names them.
  return throughWrapper(
    messenger,
    {
      self: () => messenger.self(),
      ...(mint ? { newSendId: () => mint.call(messenger) } : {}),
      me: () => timed("account.me", {}, () => messenger.me()),
      ...(chats
        ? {
            chats: (window) =>
              timed(
                "chats.list",
                {},
                () => chats.call(messenger, window),
                (page) => ({ counts: { chats: page.items.length } }),
              ),
          }
        : {}),
      ...(history
        ? {
            history: (reference, options) =>
              timed(
                "messages.list",
                {},
                () => history.call(messenger, reference, options),
                (page) => ({
                  ...(page.items[0] ? { ids: { chat: page.items[0].chatId } } : {}),
                  counts: { messages: page.items.length },
                }),
              ),
          }
        : {}),
      resolve: (reference) =>
        timed(
          "chats.resolve",
          {},
          () => messenger.resolve(reference),
          (chat) => ({ ids: { chat: chat.id } }),
        ),
      chat: (reference) =>
        timed(
          "chats.show",
          {},
          () => messenger.chat(reference),
          (card) => ({ ids: { chat: card.id }, ...(card.members ? { counts: { members: card.members.length } } : {}) }),
        ),
      ...(contact
        ? {
            contact: (reference) =>
              timed(
                "contacts.show",
                {},
                () => contact.call(messenger, reference),
                (card) => ({ ids: { person: card.id }, counts: { chats: card.chats.length } }),
              ),
          }
        : {}),
      ...(around
        ? {
            around: (reference, messageId, window) =>
              timed(
                "messages.around",
                { ids: { message_id: messageId } },
                () => around.call(messenger, reference, messageId, window),
                (items) => ({
                  ...(items[0] ? { ids: { chat: items[0].chatId, message_id: messageId } } : {}),
                  counts: { messages: items.length },
                }),
              ),
          }
        : {}),
      send: (chatId, text, options) =>
        timed(
          "messages.send",
          {
            ids: {
              chat: chatId,
              send: options.sendId,
              ...(options.replyTo ? { reply: options.replyTo } : {}),
              ...(options.threadId ? { thread: options.threadId } : {}),
            },
          },
          () => messenger.send(chatId, text, options),
          (sent) => ({ ids: { chat: sent.message.chatId || chatId, message_id: sent.message.id } }),
        ),
      ...(watch
        ? {
            watch: (onEvent, signal, onReady) =>
              counted(
                "messages.watch",
                onEvent,
                (counting) => watch.call(messenger, counting, signal, onReady),
                byEvent,
              ),
          }
        : {}),
      ...(feed
        ? { feed: (onBatch, signal) => timed("history.feed", {}, () => feed.call(messenger, onBatch, signal)) }
        : {}),
      ...(listen
        ? {
            listen: (onEvent, signal) =>
              counted("messages.listen", onEvent, (counting) => listen.call(messenger, counting, signal), byEvent),
          }
        : {}),
      ...(listenHistory
        ? {
            listenHistory: (onBatch, signal) =>
              counted("history.listen", onBatch, (counting) => listenHistory.call(messenger, counting, signal), byPart),
          }
        : {}),
      logout: () => timed("session.logout", {}, () => messenger.logout()),
      close: () => messenger.close(),
    },
    (name, call) =>
      (...args: unknown[]) =>
        timed(`adapter.${name}`, {}, () => call(...args)),
  )
}

const byEvent = (event: MessageEvent, counts: Record<string, number>): void => {
  counts[event.event] = (counts[event.event] ?? 0) + 1
}

const byPart = (batch: HistoryBatch, counts: Record<string, number>): void => {
  counts.batches = (counts.batches ?? 0) + 1
  for (const [part, items] of Object.entries(batch))
    if (Array.isArray(items) && items.length > 0) counts[part] = (counts[part] ?? 0) + items.length
}
