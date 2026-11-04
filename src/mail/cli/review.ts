import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import { defineSteps, type Missing, type NextStep, type StepDefinition, stepOf } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { environmentOf, outputFor } from "../../cli/context.js"
import { LOCAL_READ } from "../../cli/effects.js"
import { listOf, renderAnswer } from "../../cli/envelope.js"
import { listQuery, nativeField, nativeTerms, queryHelp, typedQuery } from "../../cli/list-query.js"
import { pointsOf } from "../../cli/messenger/catch-up.js"
import { catchUpQuery, summaryOf } from "../../cli/messenger/catch-up-answers.js"
import { messageItem } from "../../cli/messenger/message-items.js"
import { checkPoints } from "../../cli/messenger/points.js"
import { unansweredHours } from "../../cli/messenger/review.js"
import { parseDuration } from "../../domain/duration.js"

import { formatReference } from "../../domain/references.js"
import { AGENDA_DEFAULTS } from "../../services/agenda.js"
import { REVIEW_DAYS, reviewStart } from "../../services/inbox.js"
import type { AccountKey, EmailMarks } from "../../store/store.js"
import { readPastMark } from "../marks.js"
import { hitText } from "../read.js"
import { type MailReview, OWED_DAYS, REVIEW_THREADS, reviewMail } from "../review.js"
import type { MailMount, MailReads } from "./index.js"

const DAY = 86_400_000

/** Where a mail review starts: a time only; one thread is `conversations show`. */
export const MAIL_REVIEW_QUERY = defineQuery({
  entity: "message",
  backend: "native",
  fields: [
    nativeField({ name: "date", type: "time", operators: ["range"], example: "date>2h" }),
    nativeField({ name: "bulk", type: "kw", operators: ["term"], example: "bulk:false" }),
  ],
})

/** The mail review's steps where a host mounted them; a host lists them beside its own so its step checks know them. */
export const mailReviewSteps = (mount: MailMount = {}): StepDefinition[] => {
  const mailbox = mount.mailbox ? [{ name: mount.mailbox.option, required: true }] : []
  return defineSteps([
    {
      id: "mail-messages.acknowledge",
      command: mount.acknowledge ?? "messages acknowledge",
      args: [{ name: "holder", required: true }, { name: "cursor", required: true }, ...mailbox],
      why: "once these are processed, this moves the holder's mark past them",
    },
    {
      id: "mail-review.next",
      command: mount.review ?? "review",
      args: [{ name: "query", required: true }, ...mailbox],
      why: "the next review starts where this one ended",
    },
    ...(mount.conversation === null
      ? []
      : [
          {
            id: "mail-conversations.show",
            command: mount.conversation ?? "conversations show",
            args: [{ name: "conversation", required: true }, ...mailbox],
            why: "only the newest emails of the thread were read here; this reads it whole",
          },
        ]),
  ])
}

/** The steps of a mail CLI, whose profile names the mailbox. */
export const MAIL_REVIEW_STEPS = mailReviewSteps()

type Steps = (id: string, args: Record<string, unknown>) => NextStep[]

const stepsFor = (mount: MailMount | undefined, mailbox: AccountKey): Steps => {
  const definitions = mailReviewSteps(mount)
  const where = mount?.mailbox ? { [mount.mailbox.option]: mount.mailbox.value(mailbox) } : {}
  return (id, args) => {
    const definition = definitions.find((one) => one.id === id)
    return definition ? [stepOf(definition, { args: { ...args, ...where } })] : []
  }
}

const waitingHours = (value: unknown): number =>
  value === true ? AGENDA_DEFAULTS.waiting / 3_600_000 : parseDuration(String(value), "--waiting") / 3_600_000

const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/** A file name for the mailbox's points: they describe the mailbox, whichever profile reads it. */
const pointsName = (mailbox: AccountKey) => encodeURIComponent(mailbox.account)

const markText = (marks: EmailMarks | undefined) => {
  const said = [
    marks?.bulk ? "bulk" : "",
    marks?.listId ? `list ${marks.listId}` : "",
    marks?.ruleId ? `rule ${marks.ruleId}` : "",
  ]
  const shown = said.filter(Boolean).join(" · ")
  return shown ? `\n  [${shown}]` : ""
}

const reviewAnswer = (found: MailReview, mailbox: AccountKey, fresh: boolean, step: Steps) => {
  const read = found.chats
    .flatMap((chat) => chat.messages.map((message) => ({ ...message, chatTitle: chat.title })))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const cut = found.chats.filter((chat) => chat.more)
  const ref = (thread: string) => formatReference({ type: "chat", ...mailbox, chat: thread })
  const turns = found.unanswered !== undefined || found.waiting !== undefined
  const [first, ...rest] = cut.map((chat) => ref(chat.id))
  const wholeThread = first === undefined ? [] : step("mail-conversations.show", { conversation: first })
  const missing: Missing[] = [
    ...(first !== undefined
      ? [
          {
            field: "items",
            why:
              `only the newest emails of ${cut.length} thread(s)` +
              (rest.length ? `; read the others whole the same way: ${rest.join(", ")}` : ""),
            ...(wholeThread.length ? { step: "mail-conversations.show" } : {}),
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
      ? [{ field: "items", why: `bulk:false left out ${found.quiet} threads of mail sent to many, lists or envelopes` }]
      : []),
  ]
  const next: NextStep[] = [
    ...(!fresh && !turns
      ? step("mail-review.next", { query: `date>${quoted(found.complete ? found.until : found.since)}` })
      : []),
    ...wholeThread,
  ]
  return listOf("review", {
    items: read.map((message) => ({
      ...summaryOf(message, mailbox),
      email: {
        ...messageItem(message, mailbox).email,
        bulk: message.marks?.bulk ?? false,
        list_id: message.marks?.listId ?? null,
        rule_id: message.marks?.ruleId ?? null,
        ...(message.marks
          ? {
              fingerprint: message.marks.fingerprint,
              new_sender: message.marks.newSender,
              sender_identities: message.marks.senderIdentities,
            }
          : {}),
      },
    })),
    limit: Math.max(1, read.length),
    has_more: false,
    next,
    missing,
    meta: found.complete ? {} : { complete: false },
  })
}

const holderReview = async (command: Command, mail: MailReads, holder: string, query: string[]) => {
  const { unanswered, waiting } = command.opts<{ unanswered?: unknown; waiting?: unknown }>()
  if (typedQuery(query).trim() || unanswered !== undefined || waiting !== undefined)
    throw new CliError(
      "validation_error",
      "--holder reads past its own mark — not with a query, --unanswered or --waiting",
    )
  const { read, mailbox, marks } = await mail.read(command, async (store, mailbox) => {
    const read = await readPastMark(store, mailbox, holder)
    const account = read.emails.length ? await store.accounts.storedAccount(mailbox) : undefined
    const marks = account
      ? await store.mail.emailMarks(
          account.id,
          read.emails.map((one) => one.id),
        )
      : new Map()
    return { read, mailbox, marks }
  })
  const chats = new Map<string, MailReview["chats"][number]>()
  for (const email of read.emails) {
    const chat = chats.get(email.chatId) ?? {
      id: email.chatId,
      title: email.chatTitle,
      kind: "dialog",
      messages: [],
      more: false,
    }
    const mark = marks.get(email.id)
    chat.messages.push(mark ? { ...email, marks: mark } : email)
    chats.set(email.chatId, chat)
  }
  const now = new Date().toISOString()
  const found: MailReview = {
    since: read.mark?.throughAt ? new Date(read.mark.throughAt).toISOString() : now,
    until: now,
    complete: !read.more,
    chats: [...chats.values()],
    skipped: [],
    partial: false,
    quiet: 0,
  }
  const step = stepsFor(mail.mount, mailbox)
  const answer = reviewAnswer(found, mailbox, true, step)
  const skipped = Object.entries(read.skipped).filter(([, count]) => count > 0)
  answer.next = [...step("mail-messages.acknowledge", { holder, cursor: read.cursor }), ...(answer.next ?? [])]
  answer.missing = [
    ...(answer.missing ?? []),
    ...(read.held > 0 ? [{ field: "items", why: `${read.held} partial emails held until they are whole` }] : []),
    ...(skipped.length
      ? [{ field: "items", why: `left out: ${skipped.map(([reason, count]) => `${count} ${reason}`).join(", ")}` }]
      : []),
  ]
  const output = outputFor(command)
  renderAnswer(command, output, answer, () => {
    output.renderer.note(
      read.mark
        ? `${holder}: past ${read.mark.throughId}; acknowledge with --cursor ${read.cursor}${read.more ? "; more after these" : ""}`
        : `${holder} has no mark yet: it starts from now — acknowledge with --cursor ${read.cursor}`,
    )
    return read.emails.map((hit) => `${hitText(hit)}${markText(marks.get(hit.id))}\n`).join("")
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
      "only threads whose newest email came to you, in To or Cc, with no answer for this long — 4h, 1d; 24h if not given",
    )
    .option(
      "--waiting [duration]",
      "only threads where you wrote last and nobody answered for this long — 3d; 7d if not given",
    )
    .option(
      "--holder <name>",
      "read for this holder — an agent or a pipeline — what is stored past its processing mark, by store order; " +
        "bulk, envelopes, drafts, suspicious senders and partial mail left out; `messages acknowledge` moves the mark",
    )
    .option(
      "--new",
      "what changed since the last `review --new` of this mailbox, a point per thread — for scheduled runs",
    )
    .addHelpText(
      "after",
      `
Without a date, --unanswered and --waiting look at threads active in the last ${OWED_DAYS} days.
Every email is shown, mail sent to many too; each item's email says bulk, list_id and rule_id, and its sender_score,
the fingerprint a finding cites it by, new_sender (no earlier email from the address) and sender_identities.
bulk:false leaves out threads whose newest email is mail sent to many, a list's or recorded by an envelope rule.
Mail newer than the last finished sync waits for the next review. Each reader keeps its own --new point: you,
an agent over MCP, and each scheduled run.`,
    )
    .action(async function (this: Command, query: string[]) {
      const options = this.opts<{
        new?: boolean
        unanswered?: string | true
        waiting?: string | true
        holder?: string
      }>()
      if (options.holder !== undefined) return holderReview(this, mail, options.holder, query)
      const { since: from, meta } = catchUpQuery(query, MAIL_REVIEW_QUERY, "review")
      const bulk = nativeTerms(listQuery(typedQuery(query), MAIL_REVIEW_QUERY, "review"), "review").get("bulk")?.value
      if (bulk !== undefined && bulk !== "false")
        throw new CliError("validation_error", `bulk: takes false — leave it out to see all mail, not "${bulk}"`)
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
          ...(bulk === "false" ? { noBulk: true } : {}),
          ...(unanswered === undefined ? {} : { unansweredAfterHours: unanswered }),
          ...(waiting === undefined ? {} : { waitingAfterHours: waiting }),
        })
        return { found, mailbox, saved }
      })
      const output = outputFor(this)
      const answer = reviewAnswer(found, mailbox, saved !== undefined, stepsFor(mail.mount, mailbox))
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
        if (found.quiet > 0) output.renderer.note(`bulk:false left out ${found.quiet} threads`)
        if (read.length === 0) output.renderer.note("nothing new in the stored mail")
        return read
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
          .map((hit) => `${hitText(hit)}${markText(hit.marks)}\n`)
          .join("")
      })
      saved?.save(found.checked ?? {}, found.complete ? { through: found.until } : {})
    })
