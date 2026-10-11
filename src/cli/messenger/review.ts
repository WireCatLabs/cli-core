import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import type { MessageHit, Review } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { CHAT_KINDS } from "../../services/chats.js"
import { kindsOf, REVIEW_DAYS, reviewStart, UNANSWERED_HOURS } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { type Hearing, modelWith } from "../../speech/hearing.js"
import { parseDuration } from "../settings.js"
import { MARK_READ_OPTION, markShown, marksRead, NO_MARK_READ_OPTION } from "./catch-up.js"
import { type Messenger, messengerContext } from "./context.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"
import { PARTIAL_NOTE } from "./inbox.js"
import { checkPoints } from "./points.js"

/** `--unanswered` with no value is `true`. */
export const unansweredHours = (value: unknown, flag = "--unanswered"): number =>
  value === true ? UNANSWERED_HOURS : parseDuration(String(value), flag) / 3_600_000

/**
 * **Everything said since a point, both sides, in every chat that changed** — the reading half of a
 * review of who owes what (max-cli's `review`). Sorting it is the reader's job, person or agent.
 * Nothing is marked read unless asked, and `inbox --new` keeps its point. The rules open and close
 * tasks in the local store from what it read (`../../services/task-rules.ts`); nothing reaches the messenger.
 */
export const reviewCommand = (messenger: Messenger): Command =>
  new Command("review")
    .description("every message, yours too, in chats that changed since a point — for reviewing who owes what")
    .option(
      "--since-time <time>",
      `where the last review ended — ISO 8601, or 2h / 1d ago; ${REVIEW_DAYS} days ago if not given`,
    )
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option("--kind <kinds>", `only chats of these kinds, comma-separated: ${CHAT_KINDS.join(", ")}`)
    .option(
      "--unanswered [duration]",
      `only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d; ${UNANSWERED_HOURS}h if not given`,
    )
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .option("--new", "what changed since the last `review --new`, a point per chat — for scheduled runs")
    .option(...MARK_READ_OPTION)
    .option(...NO_MARK_READ_OPTION)
    .action(async function (this: Command) {
      const options = this.opts<{
        new?: boolean
        markRead?: boolean
        sinceTime?: string
        chat?: string
        kind?: string
        unanswered?: string | true
        all?: boolean
        transcribe?: boolean
        model?: string
      }>()
      const hearWith = modelWith(options.transcribe, options.model)
      const context = messengerContext(this, messenger)
      const { settings, renderer, format, streams, env } = context
      if (options.new && (options.sinceTime !== undefined || options.unanswered !== undefined)) {
        // An open question stays open: moving past it would drop it from the next review.
        throw new CliError("validation_error", "--new keeps its own point — not with --since-time or --unanswered")
      }
      const saved = options.new
        ? checkPoints(messenger.app, {
            command: "review",
            profile: settings.profile,
            env,
            firstLookMs: REVIEW_DAYS * 86_400_000,
          })
        : undefined
      const since =
        options.sinceTime !== undefined ? momentOf(options.sinceTime, "--since-time") : (saved?.first ?? reviewStart())
      const marking = marksRead(options.markRead, settings)
      const hours = options.unanswered === undefined ? undefined : unansweredHours(options.unanswered)
      const kinds = options.kind === undefined ? undefined : kindsOf(options.kind)
      let hearing: Hearing | undefined
      const transcribe = options.transcribe === true
      const { found, marked } = await context.withServices(async (services, connect) => {
        const found = await services.inbox.review({
          since,
          ...(saved === undefined ? {} : { points: saved.chats }),
          ...(options.chat === undefined ? {} : { chat: options.chat }),
          ...(kinds === undefined ? {} : { kinds }),
          ...(options.all ? { all: true } : {}),
          ...(hours === undefined ? {} : { unansweredAfterHours: hours }),
          enrich: async (raw) => {
            const read = raw.chats.flatMap((chat) => chat.messages)
            hearing = await hearForCommand(context, messenger, read, transcribe, hearWith, connect)
            return {
              ...raw,
              complete: raw.complete && (hearing?.unheard.length ?? 0) === 0,
              chats: raw.chats.map((chat) => ({ ...chat, messages: heardItems(chat.messages, hearing) })),
            }
          },
        })
        return { found, marked: marking ? await markShown(services, found.chats) : undefined }
      })

      const read: MessageHit[] = found.chats.flatMap((chat) =>
        chat.messages.map((message) => ({ ...message, chatTitle: chat.title })),
      )
      const messages = heardItems(read, hearing)
      found.complete &&= (hearing?.unheard.length ?? 0) === 0
      if (format === "jsonl") renderer.stream(messages)
      else if (format !== "pretty") {
        renderer.result({
          ...found,
          ...(marked === undefined ? {} : { markedRead: marked }),
          chats: found.chats.map((chat) => ({ ...chat, messages: heardItems(chat.messages, hearing) })),
          ...hearingFields(hearing, true),
        })
      } else if (messages.length > 0) {
        streams.data(
          renderMessages(spokenItems(messages, hearing), {
            color: context.color,
            verbosity: settings.detail,
            senderColors: settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
      }
      if (marked !== undefined) renderer.note(`marked ${marked.length} chat(s) read up to the newest message shown`)
      notes(found, messenger.app.command, saved !== undefined, renderer.note.bind(renderer))
      saved?.save(found.checked ?? {})
    })

const notes = (found: Review, command: string, fresh: boolean, note: (message: string) => void): void => {
  for (const chat of found.chats) {
    if (chat.more)
      note(`${chat.title ?? chat.id}: cut short, only the newest — \`${command} messages list ${chat.id}\``)
    if (chat.answeredBy === "owner")
      note(`${chat.title ?? chat.id}: its admins are not known, so only your answers count`)
  }
  if (found.skipped.length > 0) {
    const names = found.skipped.map((chat) => chat.title ?? chat.id).join(", ")
    note(`skipped ${found.skipped.length} chats — too many at once: ${names}`)
  }
  if (found.tasks && found.tasks.added + found.tasks.closed > 0)
    note(`tasks: ${found.tasks.added} opened, ${found.tasks.closed} closed by the rules`)
  if (found.partial) note(PARTIAL_NOTE)
  if (found.quiet > 0) note(`${found.quiet} muted or archived chats left out — --all reads them`)
  if (found.unanswered) {
    note(
      `questions from ${found.since} to ${found.until} still open after ${found.unanswered.olderThanHours} hours; ` +
        "an answer after the review's end is not seen",
    )
    return
  }
  if (fresh) {
    note(`from ${found.since} to ${found.until} — the next \`review --new\` goes on from here, chat by chat`)
    return
  }
  note(
    found.complete
      ? `from ${found.since} to ${found.until} — the next review starts with --since-time ${found.until}`
      : `from ${found.since} to ${found.until}, incomplete — keep --since-time ${found.since} for the next review`,
  )
}
