import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { sendTime } from "../../domain/send-time.js"
import { capability } from "../../ports/messenger.js"
import { renderMessages } from "../../render/messages.js"
import { DELETE_AT_ONCE } from "../../services/index.js"
import { ownerOnlyOption, REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { messageItem, messageItems, selfOf, viewOf } from "./message-items.js"
import { afterWrite, writtenAnswer } from "./message-writes.js"
import { HTML_HELP } from "./messages-send-command.js"
import { readAll } from "./stdin.js"

const SCHEDULED_IDS =
  "the scheduled ids `messages scheduled <chat>` lists, by spaces or commas, " +
  `at most ${DELETE_AT_ONCE}; never the id of a sent message`

const SAME_NUMBER =
  "A scheduled message has an id of its own: the same number in the chat's history is another, sent message. " +
  "Each id is checked against the scheduled list before anything changes."

const idsOf = (typed: string[]): string[] => {
  const ids = typed
    .flatMap((one) => one.split(","))
    .map((one) => one.trim())
    .filter(Boolean)
  if (ids.length === 0)
    throw new CliError("validation_error", "no scheduled id given — `messages scheduled <chat>` lists them", {
      sent: false,
    })
  return ids
}

/** Where to look after a scheduled send ended without an answer: repeating it would schedule a second one. */
export const scheduledCommand = (messenger: Messenger): Command => {
  const command = annotate(new Command("scheduled"), {
    examples: [`${messenger.app.command} personal messages scheduled "Book club"`],
    effects: REMOTE_READ,
  })
    .description("messages waiting to be sent later in a chat, soonest first, with their scheduled ids")
    .argument("<chat>", messenger.chatArgument)
    .addHelpText("after", `\n${SAME_NUMBER}`)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { items, reader } = await context.withMessenger(async (connection) => ({
        items: await capability(connection, "scheduled", "list scheduled messages")(chat),
        reader: selfOf(messenger, connection),
      }))
      if (context.format === "pretty" && items.length === 0) return context.renderer.note("nothing scheduled")
      renderAnswer(
        this,
        context,
        listOf("messages scheduled", {
          items: messageItems(items, reader),
          limit: Math.max(items.length, 1),
          has_more: false,
        }),
        () =>
          renderMessages(
            items.map((one) => ({ ...one, timestamp: one.scheduledFor ?? one.timestamp })),
            viewOf(context, messenger),
          ),
      )
    })
  command.addCommand(cancelCommand(messenger))
  command.addCommand(editCommand(messenger))
  command.addCommand(sendNowCommand(messenger))
  return annotate(command, { output: { entity: "message" } })
}

/** Nobody gets a cancelled message back, so it asks as a deletion does where the profile's level is `ask`. */
const cancelCommand = (messenger: Messenger): Command =>
  annotate(new Command("cancel"), {
    examples: [`${messenger.app.command} personal messages scheduled cancel "Book club" 3`],
    effects: REMOTE_WRITE,
    output: { entity: "scheduled_cancellation" },
  })
    .description("cancel scheduled messages before they are sent; they cannot be got back")
    .argument("<chat>", messenger.chatArgument)
    .argument("<scheduled-id...>", SCHEDULED_IDS)
    .addOption(
      ownerOnlyOption("--allow-dangerous", "go ahead without the question an ask level puts before a cancellation"),
    )
    .addHelpText("after", `\n${SAME_NUMBER}`)
    .action(async function (this: Command, chat: string, typed: string[]) {
      const ids = idsOf(typed)
      const context = messengerContext(this, messenger)
      const cancelled = await context.withServices((services) => services.messages.cancelScheduled({ chat, ids }))
      renderAnswer(this, context, itemOf(snakeKeys(cancelled)))
    })

const editCommand = (messenger: Messenger): Command => {
  const edit = annotate(new Command("edit"), {
    literal_after_dashes: true,
    examples: [
      `${messenger.app.command} personal messages scheduled edit "Book club" 3 "The meeting starts at 11."`,
      `${messenger.app.command} personal messages scheduled edit "Book club" 3 --at-time 2026-12-01T09:00`,
    ],
    effects: REMOTE_WRITE,
    output: { entity: "message_write" },
  })
    .description("change the text or the time of a scheduled message before it is sent")
    .argument("<chat>", messenger.chatArgument)
    .argument("<scheduled-id>", "the scheduled id `messages scheduled <chat>` lists; never the id of a sent message")
    .argument("[text]", "the new text; without it and without --at-time, read from stdin")
    .option("--at-time <time>", "send it at this time instead: 2026-09-25T09:00 (local time), or 30m, 2h, 1d from now")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .addHelpText("after", `\n${SAME_NUMBER}`)
    .action(async function (this: Command, chat: string, id: string, text: string | undefined) {
      const context = messengerContext(this, messenger)
      const { md: markdown, html, atTime } = this.opts<{ md?: boolean; html?: boolean; atTime?: string }>()
      const at = atTime === undefined ? undefined : sendTime(atTime)
      const body = text ?? (at === undefined ? await readAll(context.stdin) : undefined)
      if (body !== undefined && body.trim() === "")
        throw new CliError(
          "validation_error",
          "no new text — give it, pipe it in, or change only the time with --at-time",
        )
      const { edited, reader } = await context.withServices(async (services) => {
        const edited = await services.messages.editScheduled({
          chat,
          id: id.trim(),
          ...(body === undefined ? {} : { text: body }),
          ...(markdown === true ? { markdown } : {}),
          ...(html === true ? { html } : {}),
          ...(at === undefined ? {} : { at }),
        })
        return afterWrite(edited, async () => ({ edited, reader: await services.messages.reader() }))
      })
      await afterWrite(edited, () => renderAnswer(this, context, writtenAnswer(edited, reader)))
    })
  if (messenger.html) edit.option("--html", HTML_HELP)
  return edit
}

const sendNowCommand = (messenger: Messenger): Command =>
  annotate(new Command("send"), {
    examples: [`${messenger.app.command} personal messages scheduled send "Book club" 3`],
    effects: REMOTE_WRITE,
    output: { entity: "scheduled_send" },
  })
    .description("deliver what is scheduled right away instead of at its time; each gets a new id")
    .argument("<chat>", messenger.chatArgument)
    .argument("<scheduled-id...>", SCHEDULED_IDS)
    .addHelpText("after", `\n${SAME_NUMBER}`)
    .action(async function (this: Command, chat: string, typed: string[]) {
      const ids = idsOf(typed)
      const context = messengerContext(this, messenger)
      const { done, reader } = await context.withServices(async (services) => {
        const done = await services.messages.sendScheduled({ chat, ids })
        return afterWrite(done, async () => ({ done, reader: await services.messages.reader() }))
      })
      await afterWrite(done, () =>
        renderAnswer(
          this,
          context,
          itemOf({
            operation_id: done.operationId,
            chat_id: done.chatId,
            sent: done.sent,
            messages: done.messages.map((one) => messageItem(one, reader)),
          }),
        ),
      )
    })
