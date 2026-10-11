import { CliError } from "@wirecat/cli-core"
import { Command } from "commander"
import { isLocator, parseLocator } from "../../domain/locator.js"
import { SAVE_HELP } from "../../meetings/index.js"
import { renderMessages } from "../../render/messages.js"
import { renderThreadLinks } from "../../render/thread-context.js"
import { modelWith } from "../../speech/hearing.js"
import { listed, positiveCount } from "../paging.js"
import { listStart } from "./after.js"
import { type Messenger, messengerContext } from "./context.js"
import { linksCommand } from "./conversations-command.js"
import { downloadSubcommand } from "./download-command.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"
import { commentsCommand } from "./messages-comments-command.js"
import { deleteCommand } from "./messages-delete-command.js"
import { editCommand } from "./messages-edit-command.js"
import { evidenceCommand } from "./messages-evidence-command.js"
import { forwardCommand } from "./messages-forward-command.js"
import { messageLinkCommand } from "./messages-link-command.js"
import { pinCommand, unpinCommand } from "./messages-pin-command.js"
import { pressCommand } from "./messages-press-command.js"
import { scheduledCommand } from "./messages-scheduled-command.js"
import { sendCommand } from "./messages-send-command.js"
import { threadOptions, threadRequest } from "./thread-options.js"
import { transcribeSubcommand } from "./transcribe-command.js"

/** `messages`: reading, and sending through the guard. A CLI may add its own subcommands. */
export const messagesCommand = (messenger: Messenger): Command => {
  const messages = new Command("messages").description("read and send messages")
  messages.addCommand(evidenceCommand(messenger))

  messages
    .command("list")
    .description("a chat's messages, oldest to newest")
    .addHelpText("after", SAVE_HELP)
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--before-id <id>", "only messages older than this message id")
    .option("--before-time <time>", "only messages older than this ISO 8601 time, or 2h / 1d ago")
    .option("--after-id <id>", "only messages newer than this message id")
    .option("--after-time <time>", "only messages newer than this ISO 8601 time, or 2h / 1d ago")
    .option("--topic <id>", "only this forum topic; read back from its newest message or --before-id")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .option("--mark-read", "also mark the chat read up to the newest message shown; the other person sees it")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { beforeId, beforeTime, afterId, afterTime, topic, transcribe, model, markRead } = this.opts<{
        beforeId?: string
        beforeTime?: string
        afterId?: string
        afterTime?: string
        topic?: string
        transcribe?: boolean
        model?: string
        markRead?: boolean
      }>()
      const start = listStart({ beforeId, beforeTime, afterId, afterTime })
      const hearWith = modelWith(transcribe, model)
      if (markRead && topic !== undefined) {
        throw new CliError(
          "validation_error",
          "--mark-read marks the whole chat; use `chats mark-read --topic` for one",
        )
      }
      if (markRead && context.settings.offline) {
        throw new CliError("validation_error", "--mark-read tells the messenger; not with --offline")
      }
      const { limit } = context.settings
      const { page, hearing, marked } = await context.withServices(async (services, connect) => {
        const page = await services.messages.list(chat, {
          limit,
          ...start,
          ...(topic === undefined ? {} : { threadId: topic }),
        })
        const newest = page.items.at(-1)
        const marked = markRead && newest ? await services.chats.markRead({ chat, until: newest.id }) : undefined
        const hearing = await hearForCommand(context, messenger, page.items, transcribe === true, hearWith, connect)
        return { page, hearing, marked }
      })
      if (marked) context.renderer.note(`marked read up to ${marked.until}`)
      const next = (items: typeof page.items) =>
        start.after === undefined
          ? `older messages: --before-id ${items[0]?.id}`
          : `newer messages: --after-id ${items.at(-1)?.id}`
      if (context.format === "pretty") {
        // Straight to stdout: the pretty renderer keeps every string to one line, and a feed is many.
        context.streams.data(
          renderMessages(spokenItems(page.items, hearing), {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
        if (page.hasMore) context.renderer.note(next(page.items))
        return
      }
      if (context.format === "jsonl") {
        context.renderer.stream(heardItems(page.items, hearing))
        if (page.hasMore) context.renderer.note(next(page.items))
        return
      }
      context.renderer.result({
        items: heardItems(page.items, hearing),
        page: 1,
        limit,
        hasMore: page.hasMore,
        ...hearingFields(hearing, transcribe === true),
        ...(marked ? { markedRead: { operationId: marked.operationId, until: marked.until } } : {}),
      })
    })

  const readWindow = async (command: Command, chat: string, message: string | undefined, window: Window) => {
    const context = messengerContext(command, messenger)
    const target = targetOf(messenger, chat, message)
    const found = await context.withServices((services) =>
      services.messages.around(
        isLocator(chat) ? chat : target.chat,
        isLocator(chat) ? undefined : target.message,
        window,
      ),
    )
    if (context.format === "pretty") {
      context.streams.data(
        renderMessages(found, {
          color: context.color,
          verbosity: context.settings.detail,
          senderColors: context.settings.senderColors,
          profile: context.profile,
          provider: messenger.provider,
          locale: messenger.app.locale,
        }),
      )
    } else if (context.format === "jsonl") context.renderer.stream(found)
    else context.renderer.result(window.before === 0 && window.after === 0 ? found[0] : listed(found))
  }

  messages.addCommand(sendCommand(messenger))

  messages
    .command("show")
    .description("one message, by its chat and id or by its msg: locator")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      await readWindow(this, chat, message, { before: 0, after: 0 })
    })

  threadOptions(messages.command("context"))
    .description("a message and what came either side of it, oldest first")
    .addHelpText("after", SAVE_HELP)
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .option("--before-n <n>", "how many before it", count, 5)
    .option("--after-n <n>", "how many after it", count, 5)
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const { beforeN: before, afterN: after } = this.opts<{ beforeN: number; afterN: number }>()
      const requested = threadRequest(this).thread
      if (requested) {
        const context = messengerContext(this, messenger)
        const target = targetOf(messenger, chat, message)
        const found = await context.withServices((services) =>
          services.messages.thread(isLocator(chat) ? chat : target.chat, isLocator(chat) ? undefined : target.message, {
            ...requested,
            before,
            after,
          }),
        )
        if (found.fallback) context.renderer.note(`thread context uses time neighbours: ${found.fallback}`)
        if (found.stale) context.renderer.note("thread graph may be stale; stale links were not followed")
        if (found.stopped.length) context.renderer.note(`thread context stopped: ${found.stopped.join(", ")}`)
        if (context.format === "pretty") {
          context.streams.data(
            renderMessages(found.items, {
              color: context.color,
              verbosity: context.settings.detail,
              senderColors: context.settings.senderColors,
              profile: context.profile,
              provider: messenger.provider,
              locale: messenger.app.locale,
            }),
          )
          const links = renderThreadLinks(found)
          if (links) context.streams.data(`\n${links}\n`)
        } else if (context.format === "jsonl") context.renderer.stream([found])
        else context.renderer.result(found)
        return
      }
      await readWindow(this, chat, message, { before, after })
    })

  downloadSubcommand(messages, messenger)
  transcribeSubcommand(messages, messenger)

  messages.addCommand(editCommand(messenger))
  messages.addCommand(deleteCommand(messenger))
  messages.addCommand(forwardCommand(messenger))
  messages.addCommand(pinCommand(messenger))
  messages.addCommand(unpinCommand(messenger))
  if (messenger.personalBots === true) messages.addCommand(pressCommand(messenger))
  messages.addCommand(scheduledCommand(messenger))
  messages.addCommand(messageLinkCommand(messenger))
  messages.addCommand(commentsCommand(messenger))
  messages.addCommand(linksCommand(messenger))
  return messages
}

type Window = { before: number; after: number }

const count = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}

/** A chat and a message id, or one locator naming both — which must be this messenger's. */
const targetOf = (messenger: Messenger, chat: string, message: string | undefined) => {
  if (isLocator(chat)) {
    if (message !== undefined) throw new CliError("validation_error", "a locator already names the message")
    const locator = parseLocator(chat)
    if (locator.provider !== messenger.provider) {
      throw new CliError("validation_error", `that locator is a ${locator.provider} message, not ${messenger.provider}`)
    }
    return { chat: locator.chat, message: locator.message }
  }
  if (message === undefined) throw new CliError("validation_error", "which message? give its id after the chat")
  return { chat, message: message.trim() }
}

export { sendCommand } from "./messages-send-command.js"
