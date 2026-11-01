import { CliError, isCliError } from "@wirecat/cli-base"
import type { Chat, Topic, TopicChange } from "../domain/models.js"
import { capability, type ForumState } from "../ports/messenger.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import type { ChatAction, SendEntry } from "../sends/journal.js"
import { newOperationId, newSendId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

export interface TopicsService {
  show(chat: string, topic: string): Promise<Topic>
  /** The emojis `create` and `edit` take as an icon. */
  icons(): Promise<string[]>
  enable(
    chat: string,
    options: { upgrade: boolean },
  ): Promise<Operated<{ previousChatId: string; chat: Chat; upgraded: boolean; forum: true }>>
  create(
    chat: string,
    title: string,
    options: { sendId?: string; icon?: string },
  ): Promise<Operated<{ chatId: string; topic: Topic }>>
  edit(chat: string, topic: string, change: TopicChange): Promise<Operated<{ chatId: string; topic: Topic }>>
  order(chat: string, topics: string[]): Promise<Operated<{ chatId: string; order: string[] }>>
  /** Every message in it goes too, for everyone; asks first by default (`topics.delete` is `ask`). */
  delete(chat: string, topic: string): Promise<Operated<{ chatId: string; topicId: string }>>
}

const actionOf = ({ title, closed, pinned, hidden, icon }: TopicChange): ChatAction => {
  const set = [closed, pinned, hidden].filter((one) => one !== undefined).length
  if (title !== undefined || icon !== undefined || set !== 1) return "topic-edit"
  if (closed !== undefined) return closed ? "topic-close" : "topic-reopen"
  if (pinned !== undefined) return pinned ? "topic-pin" : "topic-unpin"
  return hidden ? "topic-hide" : "topic-unhide"
}

const validTitle = (title: string): void => {
  if (title.trim() === "" || new TextEncoder().encode(title).byteLength > 128)
    throw new CliError("validation_error", "a topic title needs 1–128 UTF-8 bytes")
}

const validIcon = (icon: string): string => {
  const emoji = icon.trim()
  if (emoji === "") throw new CliError("validation_error", "which icon? give an emoji from `topics icons list`")
  return emoji
}

export const topicsService = (deps: ServiceDeps): TopicsService => {
  const online = async () => {
    if (deps.offline)
      throw new CliError("validation_error", "changing topics requires the messenger; not with --offline")
    return deps.connection()
  }
  return {
    show: async (chat, topic) => {
      if (deps.offline) throw new CliError("validation_error", "`topics show` asks the messenger; not with --offline")
      const id = topic.trim()
      if (id === "") throw new CliError("validation_error", "which topic? give its id, from `topics list`")
      return capability(await deps.connection(), "topic", "show a forum topic")(chat, id)
    },
    icons: async () => {
      if (deps.offline)
        throw new CliError("validation_error", "`topics icons list` asks the messenger; not with --offline")
      return capability(await deps.connection(), "topicIcons", "list topic icons")()
    },
    enable: async (chat, { upgrade }) => {
      const connection = await online()
      const probe = capability(connection, "forumState", "configure forum topics")
      const enable = capability(connection, "enableForum", "enable forum topics")
      const previousChatId = (await connection.resolve(chat)).id
      const operationId = newOperationId()
      let prepared: ForumState | undefined
      const attempt: Omit<SendEntry, "at" | "profile" | "outcome"> & { operationId: string; key: string } = {
        operationId: `${operationId}:configure`,
        parentOperationId: operationId,
        chatId: previousChatId,
        kind: "chat",
        action: "forum-enable",
        key: "topics.enable",
      }
      const validate = async (chatId: string) => {
        const state = await probe(chatId)
        if (!state.owner) throw new CliError("permission_error", "only the group owner can enable forum topics")
        if (state.linkedDiscussion)
          throw new CliError("validation_error", "a linked discussion group cannot enable forum topics")
        if (state.needsUpgrade && !upgrade)
          throw new CliError(
            "validation_error",
            "this basic group needs --upgrade to become a supergroup; its chat id will change",
          )
        return state
      }
      const first = await guardedWrite(
        deps.guard,
        attempt,
        async () => {
          if (!prepared) throw new CliError("invalid_response", "the forum preflight did not finish")
          if (prepared.needsUpgrade)
            return capability(connection, "upgradeForum", "upgrade a basic group")(prepared.chat.id)
          return prepared.forum ? prepared : enable(prepared.chat.id)
        },
        (done) => ({ resultChatId: done.chat.id }),
        async () => {
          prepared = await validate(previousChatId)
          if (prepared.chat.id !== previousChatId)
            deps.guard.check({ ...attempt, chatId: prepared.chat.id }, { reserve: false })
          attempt.chatId = prepared.chat.id
          attempt.action = prepared.needsUpgrade ? "forum-upgrade" : "forum-enable"
        },
      )
      let current = first
      if (!current.forum && prepared?.needsUpgrade) {
        try {
          current = await guardedWrite(
            deps.guard,
            {
              operationId: `${operationId}:enable`,
              parentOperationId: operationId,
              chatId: current.chat.id,
              kind: "chat",
              action: "forum-enable",
              key: "topics.enable",
            },
            () => enable(first.chat.id),
            (done) => ({ resultChatId: done.chat.id }),
            async () => {
              await validate(first.chat.id)
            },
          )
        } catch (error) {
          throw new CliError(
            isCliError(error) ? error.code : "provider_error",
            "the group was upgraded but enabling topics did not finish; check the new chat before repeating",
            {
              ...(isCliError(error) ? error.details : {}),
              operation_id: operationId,
              previous_chat_id: previousChatId,
              chat_id: first.chat.id,
              upgraded: first.chat.id !== previousChatId,
              forum: null,
              stage: "enable",
            },
          )
        }
      }
      if (!current.forum)
        throw new CliError("invalid_response", "Telegram did not confirm that topics were enabled", {
          operation_id: operationId,
          chat_id: current.chat.id,
        })
      return {
        operationId,
        previousChatId,
        chat: current.chat,
        upgraded: current.chat.id !== previousChatId,
        forum: true,
      }
    },
    create: async (chat, title, { sendId, icon: typedIcon }) => {
      validTitle(title)
      const icon = typedIcon === undefined ? undefined : validIcon(typedIcon)
      const connection = await online()
      const create = capability(connection, "createTopic", "create forum topics")
      const probe = capability(connection, "forumState", "read forum settings")
      const chatId = (await connection.resolve(chat)).id
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      let target = chatId
      const topic = await guardedWrite(
        deps.guard,
        {
          operationId: id,
          sendId: id,
          chatId,
          kind: "chat",
          action: "topic-create",
          key: "topics.create",
          length: title.length,
        },
        () => create(target, title, { sendId: id, ...(icon === undefined ? {} : { icon }) }),
        (done) => ({ threadId: done.id, resultChatId: target }),
        async () => {
          const state = await probe(chatId)
          if (!state.forum)
            throw new CliError(
              "validation_error",
              "enable topics first with `topics enable`; creating a topic never upgrades a group",
            )
          if (!state.canCreate)
            throw new CliError("permission_error", "creating a topic requires manage-topics permission")
          target = state.chat.id
          if (target !== chatId)
            deps.guard.check({ chatId: target, kind: "chat", key: "topics.create" }, { reserve: false })
        },
      )
      return { operationId: id, chatId: target, topic }
    },
    edit: async (chat, typedTopic, change) => {
      const { title, closed, pinned, hidden } = change
      const icon = change.icon == null ? change.icon : validIcon(change.icon)
      if ([title, closed, pinned, hidden, icon].every((one) => one === undefined))
        throw new CliError(
          "validation_error",
          "nothing to change — rename, close, reopen, pin, unpin, hide or give an icon",
        )
      if (title !== undefined) validTitle(title)
      const topicId = typedTopic.trim()
      if (topicId === "") throw new CliError("validation_error", "which topic? give its id from `topics list`")
      const connection = await online()
      const editTopic = capability(connection, "editTopic", "edit forum topics")
      const chatId = (await connection.resolve(chat)).id
      const operationId = newOperationId()
      const action = actionOf(change)
      const topic = await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "chat", action, key: "topics.edit", threadId: topicId },
        () =>
          editTopic(chatId, topicId, {
            ...(title === undefined ? {} : { title }),
            ...(closed === undefined ? {} : { closed }),
            ...(pinned === undefined ? {} : { pinned }),
            ...(hidden === undefined ? {} : { hidden }),
            ...(icon === undefined ? {} : { icon }),
          }),
      )
      return { operationId, chatId, topic }
    },
    delete: async (chat, typedTopic) => {
      const topicId = typedTopic.trim()
      if (topicId === "") throw new CliError("validation_error", "which topic? give its id from `topics list`")
      if (topicId === "1")
        throw new CliError(
          "validation_error",
          "the General topic cannot be deleted; `topics edit --hidden on` hides it",
        )
      const connection = await online()
      const remove = capability(connection, "deleteTopic", "delete forum topics")
      const chatId = (await connection.resolve(chat)).id
      const operationId = newOperationId()
      await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "chat", action: "topic-delete", key: "topics.delete", threadId: topicId },
        () => remove(chatId, topicId),
      )
      return { operationId, chatId, topicId }
    },
    order: async (chat, typed) => {
      const order = typed.map((one) => one.trim())
      if (order.length === 0 || order.includes(""))
        throw new CliError("validation_error", "which topics? give the pinned topics' ids in the order wanted")
      if (new Set(order).size !== order.length)
        throw new CliError("validation_error", "a topic is named twice; give each one once")
      const connection = await online()
      const reorder = capability(connection, "orderPinnedTopics", "order pinned forum topics")
      const chatId = (await connection.resolve(chat)).id
      const operationId = newOperationId()
      await guardedWrite(
        deps.guard,
        { operationId, chatId, kind: "chat", action: "topic-order", key: "topics.edit" },
        () => reorder(chatId, order),
      )
      return { operationId, chatId, order }
    },
  }
}
