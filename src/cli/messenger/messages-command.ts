import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { isLocator, parseLocator } from "../../domain/locator.js"
import { SAVE_HELP } from "../../meetings/index.js"
import { renderMessages } from "../../render/messages.js"
import { renderThreadLinks } from "../../render/thread-context.js"
import { chatCoverage } from "../../services/chat-coverage.js"
import { readMail } from "../../services/mail-search.js"
import { storedChatId } from "../../services/message-resolution.js"
import { modelWith, spoken } from "../../speech/hearing.js"
import type { AccountKey } from "../../store/store.js"
import { REMOTE_READ } from "../effects.js"
import { itemOf, listOf, renderAnswer } from "../envelope.js"
import { queryHelp } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { syncCommand } from "./backfill-command.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"
import { linksCommand } from "./conversations-command.js"
import { downloadSubcommand } from "./download-command.js"
import {
  heardItems,
  hearForCommand,
  hearingMissing,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"
import { cursorOf, historyQuery, historyWindow } from "./history-query.js"
import { hideNever } from "./lacks.js"
import { threadAnswer } from "./message-answers.js"
import { messageItem, messageItems, type ReadMessage, viewOf } from "./message-items.js"
import { commentsCommand } from "./messages-comments-command.js"
import { deleteCommand } from "./messages-delete-command.js"
import { editCommand } from "./messages-edit-command.js"
import { evidenceCommand } from "./messages-evidence-command.js"
import { forwardCommand } from "./messages-forward-command.js"
import { messageLinkCommand } from "./messages-link-command.js"
import { pinCommand, starCommands, unpinCommand } from "./messages-pin-command.js"
import { pressCommand } from "./messages-press-command.js"
import { scheduledCommand } from "./messages-scheduled-command.js"
import { sendCommand } from "./messages-send-command.js"
import { coverageGaps } from "./search-answers.js"
import { threadOptions, threadRequest } from "./thread-options.js"
import { transcribeSubcommand } from "./transcribe-command.js"

/** `messages`: reading, and sending through the guard. A CLI may add its own subcommands. */
export const messagesCommand = (messenger: Messenger): Command => {
  const messages = new Command("messages").description("read and send messages")
  messages.addCommand(evidenceCommand(messenger))

  const history = historyQuery(messenger)
  const list = annotate(messages.command("list"), {
    examples: [`${messenger.app.command} personal messages list "Book club" --limit 20`],
    effects: REMOTE_READ,
    partial: true,
  })
    .description("a chat's messages, oldest to newest")
    .addHelpText("after", SAVE_HELP)
    .addHelpText("after", queryHelp(history))
    .argument("<chat>", messenger.chatArgument)
    .argument(
      "[query...]",
      `${
        messenger.topics === false
          ? "where to start: id<42, date>2026-10-01"
          : "where to start and which topic: id<42, date>2026-10-01, topic:12"
      }${messenger.messageStars === true ? "; starred:true keeps the ones you starred" : ""}`,
    )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--cursor <cursor>", "go on from where the last page stopped; page.next gives it")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .addHelpText("after", "To mark a chat read, use `chats mark-read <chat>`. The other side sees it.")
    .action(async function (this: Command, chat: string, query: string[]) {
      const context = messengerContext(this, messenger)
      const { cursor, transcribe, model } = this.opts<{
        cursor?: string
        transcribe?: boolean
        model?: string
      }>()
      const window = historyWindow(query, cursor, "messages list", history)
      const hearWith = modelWith(transcribe, model)
      const { limit } = context.settings
      const { page, hearing, reader } = await context.withServices(async (services, connect) => {
        const page = await services.messages.list(chat, { limit, ...window })
        const reader = await services.messages.reader()
        const hearing = await hearForCommand(context, messenger, page.items, transcribe === true, hearWith, connect)
        return { page, hearing, reader }
      })
      const next = page.hasMore
        ? cursorOf(window, { first: page.items[0]?.id, last: page.items.at(-1)?.id })
        : undefined
      // Offline, the store is the whole answer: say how much of the chat it holds. Online the messenger is read.
      const gaps = context.settings.offline
        ? coverageGaps(
            await context.withStore(async (store, account) =>
              chatCoverage(store, account, [
                await storedChatId(messenger, chat, store, account, { includeLeft: true }),
              ]),
            ),
          )
        : { next: [], missing: [] }
      renderAnswer(
        this,
        context,
        listOf("messages list", {
          items: messageItems(heardItems(page.items, hearing), reader),
          limit,
          has_more: page.hasMore,
          paging: "cursor",
          ...(next === undefined ? {} : { cursor: next }),
          args: { chat, ...(query.length > 0 ? { query: query.join(" ") } : {}) },
          next: gaps.next,
          missing: [...hearingMissing(hearing, transcribe === true), ...gaps.missing],
          ...(gaps.missing.length > 0 ? { meta: { complete: false } } : {}),
        }),
        () => renderMessages(spokenItems(page.items, hearing), viewOf(context, messenger)),
      )
    })
  annotate(list, { output: { entity: "message" }, query: history })

  const readWindow = async (command: Command, chat: string, message: string | undefined, window: Window) => {
    const context = messengerContext(command, messenger)
    const { found, reader } = await context.withServices(async (services) => ({
      found: await services.messages.around(chat, message?.trim(), window),
      reader: await services.messages.reader(),
    }))
    const hearing = await hearForCommand(context, messenger, found, false)
    printWindow(command, context, heardItems(found, hearing), reader, window)
  }

  const readMailWindow = async (command: Command, locator: string, window: Window) => {
    const context = messengerContext(command, messenger)
    const found = await context.withStore((store) => readMail(store, locator, window))
    printWindow(command, context, found, parseLocator(locator), window)
  }

  const printWindow = (
    command: Command,
    context: MessengerContext,
    found: ReadMessage[],
    reader: AccountKey,
    window: Window,
  ) => {
    const view = () => renderMessages(found.map(spoken), viewOf(context, messenger))
    if (window.before === 0 && window.after === 0) {
      const one = found.find((item) => item.anchor) ?? found[0]
      if (!one) throw new CliError("not_found", "no such message")
      return renderAnswer(command, context, itemOf(messageItem(one, reader)), view)
    }
    renderAnswer(
      command,
      context,
      listOf("messages context", {
        items: messageItems(found, reader),
        limit: window.before + window.after + 1,
        has_more: false,
      }),
      view,
    )
  }

  messages.addCommand(sendCommand(messenger))

  annotate(messages.command("show"), {
    output: { entity: "message" },
    examples: [`${messenger.app.command} personal messages show "Book club" 101`],
    effects: REMOTE_READ,
  })
    .description("one message, by its chat and id or by its msg: locator")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      if (isMailLocator(chat, message)) return await readMailWindow(this, chat, { before: 0, after: 0 })
      await readWindow(this, chat, message, { before: 0, after: 0 })
    })

  threadOptions(
    annotate(messages.command("context"), {
      output: { entity: "message_context" },
      examples: [`${messenger.app.command} personal messages context "Book club" 101 --before-n 3 --after-n 3`],
      effects: REMOTE_READ,
    }),
  )
    .description("a message and what came either side of it, oldest first")
    .addHelpText("after", SAVE_HELP)
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .option("--before-n <n>", "how many before it", count, 5)
    .option("--after-n <n>", "how many after it", count, 5)
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const { beforeN: before, afterN: after } = this.opts<{ beforeN: number; afterN: number }>()
      if (isMailLocator(chat, message)) return await readMailWindow(this, chat, { before, after })
      const requested = threadRequest(this).thread
      if (requested) {
        const context = messengerContext(this, messenger)
        const { found, reader } = await context.withServices(async (services) => ({
          found: await services.messages.thread(chat, message?.trim(), { ...requested, before, after }),
          reader: await services.messages.reader(),
        }))
        if (found.fallback) context.renderer.note(`thread context uses time neighbours: ${found.fallback}`)
        if (found.stale) context.renderer.note("thread graph may be stale; stale links were not followed")
        if (found.stopped.length) context.renderer.note(`thread context stopped: ${found.stopped.join(", ")}`)
        renderAnswer(this, context, threadAnswer(found, reader), () => {
          const links = renderThreadLinks(found)
          return `${renderMessages(found.items, viewOf(context, messenger))}${links ? `\n${links}\n` : ""}`
        })
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
  if (messenger.messageStars === true) for (const command of starCommands(messenger)) messages.addCommand(command)
  if (messenger.personalBots === true) messages.addCommand(pressCommand(messenger))
  if (messenger.scheduledSends !== false) messages.addCommand(scheduledCommand(messenger))
  messages.addCommand(messageLinkCommand(messenger))
  messages.addCommand(commentsCommand(messenger))
  messages.addCommand(linksCommand(messenger))
  messages.addCommand(syncCommand(messenger))
  return hideNever(messenger, messages)
}

type Window = { before: number; after: number }

/** Mail lives in the mail tables of the store, whichever messenger CLI reads it. */
const isMailLocator = (chat: string, message: string | undefined) =>
  message === undefined && isLocator(chat) && parseLocator(chat).provider === "email"

const count = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}

export { sendCommand } from "./messages-send-command.js"
