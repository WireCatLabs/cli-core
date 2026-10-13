import { CliError } from "@wirecat/cli-base"
import { type FormattedText, validateFormattedText, visibleFormattedText } from "../domain/formatting.js"
import { threadIdOf } from "../domain/thread.js"
import { capability, type MessengerAdapter } from "../ports/messenger.js"
import type { MediaOption, ProviderDescription as Messenger } from "../ports/provider.js"
import { codeOf, guardedWrite, type Operated } from "../sends/guarded.js"
import { sendAsCheck } from "../sends/send-as.js"
import { newOperationId, newSendId } from "../sends/send-id.js"
import { uploadSource, validateUploads } from "../sends/upload.js"
import { uploadSize } from "../sends/upload-source.js"
import type { ServiceDeps } from "./deps.js"
import type { MessagesService, MessageTarget, Pinned } from "./message-contracts.js"

/** max-cli's: many at once is what a ban for automation looks like. */
export const DELETE_AT_ONCE = 10

const formatted = async (
  connection: MessengerAdapter,
  typed: string,
  { markdown, html }: { markdown?: boolean | undefined; html?: boolean | undefined },
): Promise<FormattedText> => {
  if (markdown && html) throw new CliError("validation_error", "--md and --html mark up the text two ways; use one")
  if (markdown) return validateFormattedText(await capability(connection, "formatMarkdown", "format Markdown")(typed))
  if (html) return validateFormattedText(await capability(connection, "formatHtml", "format HTML")(typed))
  return { text: typed, spans: [] }
}

const MEDIA_FLAGS: Record<MediaOption, string> = {
  spoiler: "--spoiler",
  captionAbove: "--caption-above",
  fileName: "--filename",
}

const checkMediaOptions = (
  messenger: Pick<Messenger, "mediaOptions" | "forwardTopic">,
  asked: MediaOption[],
  attachments: number,
): void => {
  const [first] = asked
  if (first === undefined) return
  const missing = asked.find((one) => !messenger.mediaOptions?.includes(one))
  if (missing) throw new CliError("validation_error", `this messenger has no ${MEDIA_FLAGS[missing]}`)
  if (attachments === 0) throw new CliError("validation_error", `${MEDIA_FLAGS[first]} needs a --photo or --file`)
}
export type MessagesWriteService = Pick<
  MessagesService,
  "send" | "edit" | "delete" | "forward" | "pin" | "unpin" | "react"
>
export type MessagesWriteDeps = Pick<ServiceDeps, "guard" | "connection" | "agentText" | "resourceLimits"> & {
  messenger: Pick<Messenger, "mediaOptions" | "forwardTopic">
}

export const messagesWriteService = (deps: MessagesWriteDeps): MessagesWriteService => {
  const { guard } = deps

  const pinning = async (
    { chat, message }: MessageTarget,
    pinned: boolean,
    notify: boolean,
  ): Promise<Operated<Pinned>> => {
    const connection = await deps.connection()
    const act = pinned
      ? capability(connection, "pin", "pin a message")
      : capability(connection, "unpin", "unpin a message")
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(
      guard,
      { operationId, chatId, kind: "pin", key: pinned ? "messages.pin" : "messages.unpin", messageId: message, notify },
      () => act(chatId, message, { notify }),
    )
    return { operationId, chatId, messageId: message, pinned }
  }
  return {
    send: async ({
      chat,
      text: typed,
      sendId,
      replyTo: typedReplyTo,
      threadId: typedThread,
      silent,
      noPreview,
      markdown,
      html,
      at,
      attachments = [],
      key,
      origin,
      spoiler,
      captionAbove,
      sendAs,
      commentTo,
      sticker,
    }) => {
      if (sticker !== undefined && (typed.trim() !== "" || attachments.length > 0 || markdown || html))
        throw new CliError("validation_error", "a sticker goes alone — no text, no file, no photo")
      if (commentTo !== undefined && (typedReplyTo !== undefined || typedThread !== undefined))
        throw new CliError("validation_error", "a comment answers the post itself; not with --reply-to or --topic")
      const media = { ...(spoiler ? { spoiler } : {}), ...(captionAbove ? { captionAbove } : {}) }
      validateUploads(attachments, deps.resourceLimits)
      checkMediaOptions(deps.messenger, Object.keys(media) as MediaOption[], attachments.length)
      const connection = await deps.connection()
      if (at !== undefined && sendId !== undefined) {
        throw new CliError(
          "validation_error",
          "a scheduled send is never repeated: it would be scheduled twice — look in `messages scheduled` instead",
        )
      }
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "" && attachments.length === 0 && sticker === undefined) {
        throw new CliError("validation_error", "nothing to send — the marks leave no text")
      }
      const threadId = threadIdOf(typedThread)
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "send to a forum topic")
      const checkSendAs = sendAsCheck(connection, sendAs)
      const discussionOf =
        commentTo === undefined ? undefined : capability(connection, "discussionOf", "comment on a channel post")
      const { id: resolved } = await connection.resolve(chat)
      const discussion = discussionOf && commentTo !== undefined ? await discussionOf(resolved, commentTo) : undefined
      const chatId = discussion?.chatId ?? resolved
      const replyTo = discussion?.messageId ?? typedReplyTo
      await checkSendAs(chatId)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const attempt = {
        chatId,
        kind: "message" as const,
        sendId: id,
        operationId: id,
        length: text.length,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(sendAs === undefined ? {} : { sendAs }),
        ...(at === undefined ? {} : { scheduledFor: at }),
        ...(key === undefined ? {} : { key }),
        ...(origin === undefined ? {} : { origin }),
        ...(attachments.length === 0
          ? {}
          : {
              attachments: attachments.map((upload) => ({
                kind: upload.kind,
                bytes: uploadSize(uploadSource(upload)),
              })),
            }),
      }
      try {
        const done = await guardedWrite(
          guard,
          attempt,
          () =>
            connection.send(chatId, text, {
              sendId: id,
              ...(replyTo === undefined ? {} : { replyTo }),
              ...(threadId === undefined ? {} : { threadId }),
              ...(silent ? { silent } : {}),
              ...(noPreview ? { noPreview } : {}),
              ...(spans.length > 0 ? { formatting: spans } : {}),
              ...(at === undefined ? {} : { at }),
              ...(attachments.length === 0 ? {} : { attachments }),
              ...(sticker === undefined ? {} : { sticker }),
              ...media,
              ...(sendAs === undefined ? {} : { sendAs }),
            }),
          (sent) => ({ messageId: sent.message.id }),
          validate === undefined || threadId === undefined
            ? undefined
            : () => validate(chatId, threadId, { ...(replyTo === undefined ? {} : { replyTo }) }),
        )
        return { ...done, operationId: id }
      } catch (error) {
        if (at !== undefined && codeOf(error) === "outcome_unknown") {
          throw new CliError(
            "outcome_unknown",
            "no answer — the message may have been scheduled. Look in `messages scheduled` before anything else; " +
              "never send it again with --send-id",
            { scheduled_for: at },
          )
        }
        throw error
      }
    },

    edit: async ({ chat, message, text: typed, markdown, html }) => {
      const connection = await deps.connection()
      const edit = capability(connection, "edit", "edit a message")
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "") throw new CliError("validation_error", "no new text — the marks leave nothing")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const edited = await guardedWrite(
        guard,
        { operationId, chatId, kind: "edit", messageId: message, length: text.length },
        () => edit(chatId, message, text, spans.length > 0 ? { formatting: spans } : {}),
      )
      return { operationId, message: edited }
    },

    delete: async ({ chat, messages, forEveryone }) => {
      const connection = await deps.connection()
      if (messages.length > DELETE_AT_ONCE) {
        throw new CliError("validation_error", `at most ${DELETE_AT_ONCE} messages at once, got ${messages.length}`)
      }
      const remove = capability(connection, "delete", "delete messages")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "delete", count: messages.length, forEveryone }, () =>
        remove(chatId, messages, { forEveryone }),
      )
      return { operationId, chatId, deleted: messages, forEveryone }
    },

    forward: async ({ chat, message, to, silent, sendId, sendAs, threadId: typedThread }) => {
      const connection = await deps.connection()
      const forward = capability(connection, "forward", "forward a message")
      const threadId = threadIdOf(typedThread)
      if (threadId !== undefined && deps.messenger.forwardTopic !== true)
        throw new CliError("validation_error", "this messenger cannot forward to a forum topic")
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "forward to a forum topic")
      const checkSendAs = sendAsCheck(connection, sendAs)
      const { id: fromChatId } = await connection.resolve(chat)
      const { id: toChatId } = await connection.resolve(to)
      await checkSendAs(toChatId)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const forwarded = await guardedWrite(
        guard,
        {
          operationId: id,
          sendId: id,
          chatId: toChatId,
          kind: "forward",
          ...(threadId === undefined ? {} : { threadId }),
          ...(sendAs === undefined ? {} : { sendAs }),
        },
        () =>
          forward(fromChatId, message, toChatId, {
            sendId: id,
            ...(silent ? { silent } : {}),
            ...(sendAs === undefined ? {} : { sendAs }),
            ...(threadId === undefined ? {} : { threadId }),
          }),
        (done) => ({ messageId: done.id }),
        validate === undefined || threadId === undefined ? undefined : () => validate(toChatId, threadId, {}),
      )
      return { operationId: id, sendId: id, message: forwarded }
    },

    pin: ({ notify, ...target }) => pinning(target, true, notify),

    unpin: (target) => pinning(target, false, false),

    react: async ({ chat, message, emoji }) => {
      const connection = await deps.connection()
      if (emoji === "") throw new CliError("validation_error", "which emoji? give one, for example 👍")
      const react = capability(connection, "react", "react to a message")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "reaction", messageId: message }, () =>
        react(chatId, message, emoji),
      )
      return { operationId, chatId, messageId: message, reaction: emoji }
    },
  }
}
