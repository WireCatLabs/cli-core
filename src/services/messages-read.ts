import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../domain/locator.js"
import { messageLinkTarget, validatePermalink } from "../domain/message-link.js"
import type { Message, Page } from "../domain/models.js"
import { threadIdOf } from "../domain/thread.js"
import { capability } from "../ports/messenger.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { fromStore, PUSHED, type ServiceDeps } from "./deps.js"
import type { ListWindow, MessagesService } from "./message-contracts.js"
import { readChatId, storedChatId } from "./message-resolution.js"
import { readThreadContext } from "./thread-context.js"

export type MessagesReadService = Pick<
  MessagesService,
  "list" | "around" | "thread" | "comments" | "link" | "download" | "keepDownloaded"
>
export type MessageReadStore = Pick<MessageStore, "messages" | "around" | "keepDownloads" | "chats" | "countMessages"> &
  import("./thread-context.js").ThreadReadStore

export type MessagesReadDeps = Omit<
  Pick<ServiceDeps, "account" | "reads" | "offline" | "connection" | "messenger">,
  "messenger"
> & {
  store: () => Promise<MessageReadStore>
  messenger: Pick<import("../ports/provider.js").ProviderDescription, "app" | "provider" | "fetching" | "savedChatId">
}

export const messagesReadService = (deps: MessagesReadDeps): MessagesReadService => {
  const inStore = async <T>(read: (store: MessageReadStore, account: AccountKey) => Promise<T>): Promise<T> =>
    read(await deps.store(), await deps.account())

  const topicPage = async (
    chat: string,
    threadId: string,
    { limit, before, beforeTime, after }: ListWindow,
  ): Promise<Page<Message>> => {
    if (beforeTime !== undefined || after !== undefined)
      throw new CliError("validation_error", "a topic is read back from its newest message, or from --before-id")
    if (threadId === "1")
      throw new CliError(
        "validation_error",
        "the General topic's messages carry no topic id — read the whole chat without --topic",
      )
    const window = { limit, ...(before === undefined ? {} : { before }) }
    if (fromStore(deps)) {
      return inStore(async (store, account) =>
        store.messages(account, await readChatId(deps, chat, store, account), { ...window, threadId }),
      )
    }
    return capability(await deps.connection(), "topicHistory", "read one forum topic")(chat, threadId, window)
  }

  const listPage = async (
    chat: string,
    { limit, before, beforeTime, after, threadId: typedThread }: ListWindow,
  ): Promise<Page<Message>> => {
    const threadId = threadIdOf(typedThread)
    if (threadId !== undefined) return topicPage(chat, threadId, { limit, before, beforeTime, after })
    if (beforeTime !== undefined) {
      if (deps.offline)
        throw new CliError("validation_error", "reading back from a time asks the messenger; not with --offline")
      if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages back from a message only`)
      const connection = await deps.connection()
      return capability(connection, "historyBefore", "read back from a time")(chat, { limit, time: beforeTime })
    }
    if (after !== undefined) {
      if (deps.offline)
        throw new CliError("validation_error", "reading forward asks the messenger; the store pages only backwards")
      if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages only backwards`)
      const connection = await deps.connection()
      return capability(connection, "historyAfter", "read forward from a message")(chat, { limit, after })
    }
    const window = { limit, ...(before === undefined ? {} : { before }) }
    if (fromStore(deps)) {
      return inStore(async (store, account) =>
        store.messages(account, await readChatId(deps, chat, store, account), window),
      )
    }
    return capability(await deps.connection(), "history", "read a chat's history")(chat, window)
  }
  return {
    // A provider caps its pages (Telegram at 100), so a larger --limit reads on from the last page's edge.
    // Only by id: where `before` is a send time (MAX), messages sharing the edge moment would be skipped.
    list: async (chat, window) => {
      const forward = window.after !== undefined
      let page = await listPage(chat, window)
      let items = page.items
      const byId = (deps.messenger.fetching?.orderBy ?? "id") === "id"
      while (byId && page.hasMore && items.length < window.limit) {
        const edge = forward ? items.at(-1) : items[0]
        if (!edge) break
        const { beforeTime: _first, ...rest } = window
        const next = forward
          ? { ...rest, limit: window.limit - items.length, after: { id: edge.id } }
          : { ...rest, limit: window.limit - items.length, before: edge.id }
        page = await listPage(chat, next)
        const seen = new Set(items.map((one) => one.id))
        const fresh = page.items.filter((one) => !seen.has(one.id))
        if (fresh.length === 0) break
        items = forward ? [...items, ...fresh] : [...fresh, ...items]
      }
      return { items, hasMore: page.hasMore }
    },

    around: async (reference, message, window) => {
      const target = messageLinkTarget(reference, message, deps.messenger.provider)
      if (target.account !== undefined) {
        const account = await deps.account()
        if (account.provider !== deps.messenger.provider || target.account !== account.account)
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
      }
      if (fromStore(deps)) {
        return inStore(async (store, account) =>
          store.around(account, await readChatId(deps, target.chat, store, account), target.message, window),
        )
      }
      return capability(await deps.connection(), "around", "read the messages around one")(
        target.chat,
        target.message,
        window,
      )
    },

    thread: (reference, message, options) =>
      inStore(async (store, account) => {
        const target = messageLinkTarget(reference, message, deps.messenger.provider)
        if (
          account.provider !== deps.messenger.provider ||
          (target.account !== undefined && target.account !== account.account)
        )
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
        return readThreadContext(
          store,
          account,
          await storedChatId(deps.messenger, target.chat, store, account),
          target.message,
          options,
        )
      }),

    comments: async (chat, typedPost, window) => {
      const post = typedPost.trim()
      if (post === "") throw new CliError("validation_error", "which post? give its message id in the channel")
      if (deps.offline)
        throw new CliError("validation_error", "comments are read from the messenger; not with --offline")
      const connection = await deps.connection()
      const discussionOf = capability(connection, "discussionOf", "read comments on a channel post")
      const comments = capability(connection, "comments", "read comments on a channel post")
      const { id: channelId } = await connection.resolve(chat)
      const discussion = await discussionOf(channelId, post)
      return { discussion, ...(await comments(channelId, post, window)) }
    },

    link: async (reference, message) => {
      const target = messageLinkTarget(reference, message, deps.messenger.provider)
      const account = await deps.account()
      if (
        account.provider !== deps.messenger.provider ||
        (target.account !== undefined && target.account !== account.account)
      )
        throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
      if (fromStore(deps)) {
        const store = await deps.store()
        const chat = await readChatId(deps, target.chat, store, account)
        const found = await store.around(account, chat, target.message, { before: 0, after: 0 })
        if (!found.some((item) => item.id === target.message && item.chatId === chat))
          throw new CliError("not_found", "no such message in this account's stored chat")
        return {
          locator: formatLocator({ ...account, chat, message: target.message }),
          url: null,
          access: "unavailable",
          reason: deps.offline ? "offline" : "unsupported_provider",
        }
      }
      const connection = await deps.connection()
      if (connection.self() !== account.account)
        throw new CliError(
          "authentication_error",
          "the connected account differs from the recorded profile; refresh the session before linking",
        )
      const { id: chat } = await connection.resolve(target.chat)
      const locator = formatLocator({ ...account, chat, message: target.message })
      if (connection.permalink)
        return { locator, ...validatePermalink(await connection.permalink(chat, target.message)) }
      const found = await capability(connection, "around", "read a message")(chat, target.message, {
        before: 0,
        after: 0,
      })
      if (!found.some((item) => item.id === target.message && item.chatId === chat))
        throw new CliError("not_found", "no such message in this chat")
      return { locator, url: null, access: "unavailable", reason: "unsupported_provider" }
    },

    download: async (chat, message) =>
      capability(await deps.connection(), "download", "download attachments")(chat, message),

    keepDownloaded: (chat, message, files) =>
      inStore(async (store, account) => {
        const chatId =
          (await storedChatId(deps.messenger, chat, store, account).catch(() => undefined)) ??
          (await (await deps.connection()).resolve(chat)).id
        return store.keepDownloads(account, chatId, message, files)
      }),
  }
}
