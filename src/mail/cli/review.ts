import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import { defineSteps, type Missing, type NextStep, type StepDefinition, stepOf } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { environmentOf, outputFor } from "../../cli/context.js"
import { LOCAL_READ } from "../../cli/effects.js"
import { listOf, renderAnswer } from "../../cli/envelope.js"
import { nativeField, queryHelp } from "../../cli/list-query.js"
import { pointsOf } from "../../cli/messenger/catch-up.js"
import { catchUpQuery, summaryOf } from "../../cli/messenger/catch-up-answers.js"
import { checkPoints } from "../../cli/messenger/points.js"
import { unansweredHours } from "../../cli/messenger/review.js"
import { parseDuration } from "../../domain/duration.js"

import { formatReference } from "../../domain/references.js"
import { AGENDA_DEFAULTS } from "../../services/agenda.js"
import { REVIEW_DAYS, reviewStart } from "../../services/inbox.js"
import type { AccountKey } from "../../store/store.js"
import { hitText } from "../read.js"
import { type MailReview, OWED_DAYS, REVIEW_THREADS, reviewMail } from "../review.js"
import type { MailReads } from "./index.js"

const DAY = 86_400_000

/** Where a mail review starts: a time only; one thread is `conversations show`. */
export const MAIL_REVIEW_QUERY = defineQuery({
  entity: "message",
  backend: "native",
  fields: [nativeField({ name: "date", type: "time", operators: ["range"], example: "date>2h" })],
})

/** The mail review's steps; a host lists them beside its own so its step checks know them. */
export const MAIL_REVIEW_STEPS = defineSteps([
  {
    id: "mail-review.next",
    command: "review",
    args: [{ name: "query", required: true }],
    why: "the next review starts where this one ended",
  },
  {
    id: "mail-review.all",
    command: "review",
    args: [{ name: "all", required: true }],
    why: "mail sent to many, mailing lists, envelopes and suspect senders were left out; --all reads them too",
  },
  {
    id: "mail-conversations.show",
    command: "conversations show",
    args: [{ name: "conversation", required: true }],
    why: "only the newest emails of the thread were read here; this reads it whole",
  },
])
const step = (id: string) => MAIL_REVIEW_STEPS.find((one) => one.id === id) as StepDefinition

const waitingHours = (value: unknown): number =>
  value === true ? AGENDA_DEFAULTS.waiting / 3_600_000 : parseDuration(String(value), "--waiting") / 3_600_000

const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/** A file name for the mailbox's points: they describe the mailbox, whichever profile reads it. */
const pointsName = (mailbox: AccountKey) => encodeURIComponent(mailbox.account)

const reviewAnswer = (found: MailReview, mailbox: AccountKey, fresh: boolean) => {
  const read = found.chats
    .flatMap((chat) => chat.messages.map((message) => ({ ...message, chatTitle: chat.title })))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const cut = found.chats.filter((chat) => chat.more)
  const ref = (thread: string) => formatReference({ type: "chat", ...mailbox, chat: thread })
  const turns = found.unanswered !== undefined || found.waiting !== undefined
  const missing: Missing[] = [
    ...(cut.length > 0
      ? [
          {
            field: "items",
            why: `only the newest emails of ${cut.length} thread(s)`,
            step: "mail-conversations.show",
          },
        ]
      : []),
    ...(found.skipped.length > 0
      ? [
          {
            field: "items",
            why: `skipped ${found.skipped.length} threads — more than ${REVIEW_THREADS} at once; the next review reads them`,
          },
        ]
      : []),
    ...(found.quiet > 0
      ? [
          {
            field: "items",
            why: `${found.quiet} threads of mail sent to many, mailing lists, envelopes or suspect senders left out`,
            step: "mail-review.all",
          },
        ]
      : []),
  ]
  const next: NextStep[] = [
    ...(!fresh && !turns
      ? [
          stepOf(step("mail-review.next"), {
            args: { query: `date>${quoted(found.complete ? found.until : found.since)}` },
          }),
        ]
      : []),
    ...cut.map((chat) => stepOf(step("mail-conversations.show"), { args: { conversation: ref(chat.id) } })),
  ]
  return listOf("review", {
    items: read.map((message) => summaryOf(message, mailbox)),
    limit: Math.max(1, read.length),
    has_more: false,
    next,
    missing,
    meta: found.complete ? {} : { complete: false },
  })
}

/**
 * `review` over the stored mail of the profile's mailbox, with tg's words: what is new, what the owner owes, what
 * waits for an answer. It reads the store only and opens no task.
 */
export const mailReviewCommand = (mail: MailReads): Command =>
  annotate(new Command("review"), {
    examples: [
      `${mail.app.command} personal review "date>2h"`,
      `${mail.app.command} personal review --new`,
      `${mail.app.command} personal review --unanswered 1d`,
      `${mail.app.command} personal review --waiting 7d`,
    ],
    effects: LOCAL_READ,
    partial: true,
    output: { entity: "message", view: "summary" },
    query: MAIL_REVIEW_QUERY,
  })
    .summary("threads with new mail, mail you owe an answer, mail waiting for one")
    .description(
      "every stored email, yours too, in threads that changed since a point — for reviewing who owes what. " +
        "It reads what sync stored, so it asks the mail server nothing",
    )
    .addHelpText("after", queryHelp(MAIL_REVIEW_QUERY))
    .argument("[query...]", `where the last review ended: date>2h; ${REVIEW_DAYS} days ago if no date`)
    .option(
      "--unanswered [duration]",
      "only threads whose newest email came to you in To, as personal mail, and has no answer for this long — 4h, 1d; 24h if not given",
    )
    .option(
      "--waiting [duration]",
      "only threads where you wrote last and nobody answered for this long — 3d; 7d if not given",
    )
    .option("--all", "mail sent to many, mailing lists, envelopes and suspect senders too — left out by default")
    .option(
      "--new",
      "what changed since the last `review --new` of this mailbox, a point per thread — for scheduled runs",
    )
    .addHelpText(
      "after",
      `
Without a date, --unanswered and --waiting look at threads active in the last ${OWED_DAYS} days.
Personal mail: not in the bulk mailbox, no List-Id, not recorded by an envelope rule, sender not suspicious.
Mail newer than the last finished sync waits for the next review. Each reader keeps its own --new point: you,
an agent over MCP, and each scheduled run.`,
    )
    .action(async function (this: Command, query: string[]) {
      const options = this.opts<{ new?: boolean; unanswered?: string | true; waiting?: string | true; all?: boolean }>()
      const { since: from, meta } = catchUpQuery(query, MAIL_REVIEW_QUERY, "review")
      const turns = options.unanswered !== undefined || options.waiting !== undefined
      if (options.new && (from !== undefined || turns))
        throw new CliError("validation_error", "--new keeps its own point — not with a date, --unanswered or --waiting")
      const unanswered = options.unanswered === undefined ? undefined : unansweredHours(options.unanswered)
      const waiting = options.waiting === undefined ? undefined : waitingHours(options.waiting)
      const env = environmentOf(this).env ?? process.env
      const now = Date.now()
      const { found, mailbox, saved } = await mail.read(this, async (store, mailbox) => {
        const saved = options.new
          ? checkPoints(mail.app, {
              command: pointsOf(this, "review", mail.app),
              profile: pointsName(mailbox),
              env,
              firstLookMs: REVIEW_DAYS * DAY,
            })
          : undefined
        const since = from ?? saved?.first ?? (turns ? now - OWED_DAYS * DAY : reviewStart(now))
        const found = await reviewMail(store, mailbox, {
          since,
          now,
          ...(saved ? { points: saved.chats } : {}),
          ...(options.all ? { all: true } : {}),
          ...(unanswered === undefined ? {} : { unansweredAfterHours: unanswered }),
          ...(waiting === undefined ? {} : { waitingAfterHours: waiting }),
        })
        return { found, mailbox, saved }
      })
      const output = outputFor(this)
      const answer = reviewAnswer(found, mailbox, saved !== undefined)
      if (meta) answer.meta = { ...meta, ...answer.meta }
      renderAnswer(this, output, answer, () => {
        const read = found.chats.flatMap((chat) => chat.messages)
        if (found.unanswered || found.waiting)
          output.renderer.note(
            `${[
              found.unanswered ? `owed for ${found.unanswered.olderThanHours}h or more` : "",
              found.waiting ? `waiting ${found.waiting.olderThanHours}h or more` : "",
            ]
              .filter(Boolean)
              .join(", ")}, threads active from ${found.since}`,
          )
        else output.renderer.note(`from ${found.since} to ${found.until}${found.complete ? "" : ", incomplete"}`)
        if (found.quiet > 0)
          output.renderer.note(
            `${found.quiet} threads of mail sent to many, lists or suspect senders left out; --all reads them`,
          )
        if (read.length === 0) output.renderer.note("nothing new in the stored mail")
        return read
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
          .map((hit) => `${hitText(hit)}\n`)
          .join("")
      })
      saved?.save(found.checked ?? {}, found.complete ? { through: found.until } : {})
    })
