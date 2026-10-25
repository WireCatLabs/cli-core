import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import type { Review } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { REVIEW_DAYS, reviewStart, UNANSWERED_HOURS } from "../../services/inbox.js"
import { type Hearing, modelWith } from "../../speech/hearing.js"
import { REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { queryHelp } from "../list-query.js"
import { pointsOf } from "./catch-up.js"
import { catchUpQuery, OFFLINE_REVIEW, REVIEW_QUERY, reviewAnswer } from "./catch-up-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { heardItems, hearForCommand, MODEL_OPTION, spokenItems, TRANSCRIBE_OPTION } from "./hearing-command.js"
import { PARTIAL_NOTE } from "./inbox.js"
import { viewOf } from "./message-items.js"
import { checkPoints } from "./points.js"

/** `--unanswered` with no value is `true`. */
export const unansweredHours = (value: unknown, flag = "--unanswered"): number =>
  value === true ? UNANSWERED_HOURS : parseDuration(String(value), flag) / 3_600_000

/**
 * **Everything said since a point, both sides, in every chat that changed** — the reading half of a
 * review of who owes what (max-cli's `review`). Sorting it is the reader's job, person or agent.
 * Reading never marks a chat read, and `inbox --new` keeps its point. The rules open and close
 * tasks in the local store from what it read (`../../services/task-rules.ts`); nothing reaches the messenger.
 */
export const reviewCommand = (messenger: Messenger): Command =>
  annotate(new Command("review"), {
    examples: [`${messenger.app.command} personal review "date>2h"`],
    effects: REMOTE_READ,
    output: { entity: "message", view: "summary" },
    query: REVIEW_QUERY,
  })
    .summary("chats with new activity or unanswered messages")
    .description("every message, yours too, in chats that changed since a point — for reviewing who owes what")
    .addHelpText("after", queryHelp(REVIEW_QUERY))
    .argument(
      "[query...]",
      `where the last review ended and which chat: date>2h, chat:"Book club"; ${REVIEW_DAYS} days ago if no date`,
    )

    .option(
      "--unanswered [duration]",
      `only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d; ${UNANSWERED_HOURS}h if not given`,
    )
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .option("--new", "what changed since the last `review --new`, a point per chat — for scheduled runs")
    .addHelpText(
      "after",
      "With --offline it reads the local store: only what was already synced, and --new keeps its point.",
    )
    .addHelpText("after", "To mark a chat read, use `chats mark-read <chat>`. The other side sees it.")
    .action(async function (this: Command, query: string[]) {
      const options = this.opts<{
        new?: boolean
        unanswered?: string | true
        all?: boolean
        transcribe?: boolean
        model?: string
      }>()
      const hearWith = modelWith(options.transcribe, options.model)
      const context = messengerContext(this, messenger)
      const { settings, renderer, format, env } = context
      const { since: from, chat, meta, kinds } = catchUpQuery(query, REVIEW_QUERY, "review")
      if (options.new && (from !== undefined || options.unanswered !== undefined)) {
        // An open question stays open: moving past it would drop it from the next review.
        throw new CliError("validation_error", "--new keeps its own point — not with a date or --unanswered")
      }
      const saved = options.new
        ? checkPoints(messenger.app, {
            command: pointsOf(this, "review"),
            profile: settings.profile,
            env,
            firstLookMs: REVIEW_DAYS * 86_400_000,
          })
        : undefined
      const since = from ?? saved?.first ?? reviewStart()
      const hours = options.unanswered === undefined ? undefined : unansweredHours(options.unanswered)
      let hearing: Hearing | undefined
      const transcribe = options.transcribe === true
      const { found, reader } = await context.withServices(async (services, connect) => {
        const found = await services.inbox.review({
          since,
          ...(saved === undefined ? {} : { points: saved.chats }),
          ...(chat === undefined ? {} : { chat }),
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
        return {
          found,
          reader: await services.messages.reader(),
        }
      })

      found.complete &&= (hearing?.unheard.length ?? 0) === 0
      notes(found, format === "pretty", renderer)
      renderAnswer(
        this,
        context,
        reviewAnswer(found, hearing, reader, {
          transcribe,
          fresh: saved !== undefined,
          ...(chat === undefined ? {} : { chat }),
          ...(meta === undefined ? {} : { meta }),
        }),
        () => {
          const read = found.chats
            .flatMap((one) => one.messages.map((message) => ({ ...message, chatTitle: one.title })))
            .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
          return read.length === 0 ? "" : renderMessages(spokenItems(read, hearing), viewOf(context, messenger))
        },
      )
      if (!found.offline) saved?.save(found.checked ?? {})
    })

/** What the answer's steps do not say: a person's context for the review just shown. */
const notes = (
  found: Review,
  pretty: boolean,
  renderer: { note: (text: string) => void; warn: (text: string) => void },
) => {
  for (const chat of found.chats)
    if (chat.answeredBy === "owner")
      renderer.note(`${chat.title ?? chat.id}: its admins are not known, so only your answers count`)
  if (found.tasks && found.tasks.added + found.tasks.closed > 0)
    renderer.note(
      `tasks: ${found.tasks.added} opened, ${found.tasks.closed} closed by the rules` +
        (found.tasks.review > 0 ? `, ${found.tasks.review} pair(s) to review — tasks duplicates list` : ""),
    )
  if (found.partial && pretty) renderer.warn(PARTIAL_NOTE)
  if (found.offline && pretty) renderer.warn(OFFLINE_REVIEW)
  if (found.unanswered)
    renderer.note(
      `questions from ${found.since} to ${found.until} still open after ${found.unanswered.olderThanHours} hours; ` +
        "an answer after the review's end is not seen",
    )
  else if (pretty) renderer.note(`from ${found.since} to ${found.until}${found.complete ? "" : ", incomplete"}`)
}
