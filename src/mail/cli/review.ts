import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import {
  defineSteps,
  MAX_NEXT_STEPS,
  type Missing,
  type NextStep,
  type StepDefinition,
  stepOf,
} from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { environmentOf, outputFor } from "../../cli/context.js"
import { LOCAL_READ } from "../../cli/effects.js"
import { listOf } from "../../cli/envelope.js"
import { listQuery, nativeField, nativeTerms, queryHelp, typedQuery } from "../../cli/list-query.js"
import { answerLocally } from "../../cli/local-times.js"
import { pointsOf } from "../../cli/messenger/catch-up.js"
import { catchUpQuery, SUMMARY_UNTRUSTED, summaryOf } from "../../cli/messenger/catch-up-answers.js"
import { messageItem } from "../../cli/messenger/message-items.js"
import { checkPoints } from "../../cli/messenger/points.js"
import { unansweredHours } from "../../cli/messenger/review.js"
import { MAIL_HIT_UNTRUSTED } from "../../cli/messenger/search-answers.js"
import { mailOwnText } from "../../conversations/mail-text.js"
import { parseDuration } from "../../domain/duration.js"
import { formatReference } from "../../domain/references.js"
import { AGENDA_DEFAULTS } from "../../services/agenda.js"
import { REVIEW_DAYS, reviewStart } from "../../services/inbox.js"
import type { AccountKey, EmailMarks } from "../../store/store.js"
import { cursorOf, findingsKeyOf, readPastMark } from "../marks.js"
import { BULK_TRIAGE_DEFAULTS } from "../newsletter.js"
import { hitText } from "../read.js"
import { type MailHit, type MailReview, OWED_DAYS, REVIEW_THREADS, reviewMail } from "../review.js"
import type { MailMount, MailReads } from "./index.js"

const DAY = 86_400_000

const REVIEW_UNTRUSTED = [...SUMMARY_UNTRUSTED, ...MAIL_HIT_UNTRUSTED]

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
  const findings = mount.findings
    ? [
        {
          id: "mail-findings.add",
          command: mount.findings,
          args: [{ name: "key", required: true }, ...mailbox],
          why: "stage what these emails ask under this key, before acknowledging them",
        },
      ]
    : []
  return defineSteps([
    ...findings,
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

const markText = (marks: EmailMarks | undefined, excerptOnly = false, partial = false) => {
  const said = [
    marks?.bulk || excerptOnly ? "bulk" : "",
    excerptOnly ? "excerpt only" : "",
    partial ? "partial: not fully downloaded" : "",
    marks?.listId ? `list ${marks.listId}` : "",
    marks?.ruleId ? `rule ${marks.ruleId}` : "",
  ]
  const shown = said.filter(Boolean).join(" · ")
  return shown ? `\n  [${shown}]` : ""
}

const reviewAnswer = (found: MailReview, mailbox: AccountKey, fresh: boolean, step: Steps) => {
  // Excerpts come after the mail written to the owner, so an agent with a budget reads that first.
  const read = found.chats
    .flatMap((chat) => chat.messages.map((message) => ({ ...message, chatTitle: chat.title })))
    .sort(
      (a, b) =>
        Number(a.excerptOnly ?? false) - Number(b.excerptOnly ?? false) ||
        Date.parse(a.timestamp) - Date.parse(b.timestamp),
    )
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
        bulk: (message.marks?.bulk ?? false) || message.excerptOnly === true,
        ...(message.excerptOnly ? { excerpt_only: true } : {}),
        ...(message.partialExcerpt ? { partial: true } : {}),
        ...(message.through ? { cursor: message.through.cursor, findings_key: message.through.findingsKey } : {}),
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
      untrusted: REVIEW_UNTRUSTED,
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
  const triage = mail.bulkTriage?.(command) ?? BULK_TRIAGE_DEFAULTS
  const now = Date.now()
  const { read, mailbox, marks } = await mail.read(command, async (store, mailbox) => {
    const read = await readPastMark(store, mailbox, holder, { triage, now })
    const ids = [...read.emails, ...read.excerpts.map(({ email }) => email)].map((one) => one.id)
    const account = ids.length ? await store.accounts.storedAccount(mailbox) : undefined
    const marks = account ? await store.mail.emailMarks(account.id, ids) : new Map()
    return { read, mailbox, marks }
  })
  const markedThrough = read.mark?.throughId ?? 0
  const heldThrough = [...read.emails, ...read.excerpts.map(({ email }) => email)].reduce(
    (most, { storeId }) => (storeId <= markedThrough ? Math.max(most, storeId) : most),
    0,
  )
  // A held email is older than the mark, and a cursor never moves the mark back.
  const through = (id: number) => {
    const held = id <= markedThrough
    const at = held ? markedThrough : id
    return {
      cursor: cursorOf(at, now),
      findingsKey: findingsKeyOf(holder, at, read.mark?.resets ?? 0, held ? heldThrough : undefined),
    }
  }
  // An agent reads this: earlier mail and signatures stay out of its text; the fingerprint is over the stored body.
  const listed: (MailHit & { storeId: number })[] = [
    ...read.emails.map((email) => ({ ...email, text: mailOwnText(email.text) })),
    ...read.excerpts.map(({ email, excerpt, partial }) => {
      const subject = email.email?.subject
      return {
        ...email,
        text: subject ? `${subject}\n\n${excerpt}` : excerpt,
        excerptOnly: true as const,
        ...(partial ? { partialExcerpt: true as const } : {}),
      }
    }),
  ]
  const emails = listed.map(({ storeId, ...email }) => ({ ...email, through: through(storeId) }))
  const chats = new Map<string, MailReview["chats"][number]>()
  for (const email of emails) {
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
  const until = new Date(now).toISOString()
  const found: MailReview = {
    since: read.mark?.throughAt ? new Date(read.mark.throughAt).toISOString() : until,
    until,
    complete: !read.more,
    chats: [...chats.values()],
    skipped: [],
    partial: false,
    quiet: 0,
  }
  const step = stepsFor(mail.mount, mailbox)
  const answer = reviewAnswer(found, mailbox, true, step)
  const skipped = Object.entries(read.skipped).filter(([, count]) => count > 0)
  const stage =
    read.findingsKey === undefined || emails.length === 0 ? [] : step("mail-findings.add", { key: read.findingsKey })
  answer.next = [
    ...stage,
    ...step("mail-messages.acknowledge", { holder, cursor: read.cursor }),
    ...(answer.next ?? []),
  ].slice(0, MAX_NEXT_STEPS)
  answer.missing = [
    ...(answer.missing ?? []),
    ...(read.held > 0 ? [{ field: "items", why: `${read.held} partial emails held until they are whole` }] : []),
    ...(skipped.length
      ? [{ field: "items", why: `left out: ${skipped.map(([reason, count]) => `${count} ${reason}`).join(", ")}` }]
      : []),
    ...(read.excerpts.length
      ? [
          {
            field: "items",
            why:
              `${read.excerpts.length} bulk emails (excerpt_only) as their subject and first lines: ` +
              "read one whole with `messages show <ref>` when it is an order, an invoice or a request",
          },
        ]
      : []),
  ]
  const output = outputFor(command)
  answerLocally(command, output, answer, (local) => {
    output.renderer.note(
      read.mark
        ? `${holder}: past ${read.mark.throughId}${emails.length ? `; findings key ${read.findingsKey}` : ""}; acknowledge with --cursor ${read.cursor}${read.more ? "; more after these" : ""}`
        : `${holder} has no mark yet: it starts from now — acknowledge with --cursor ${read.cursor}`,
    )
    return emails
      .map(
        (hit) =>
          `${hitText(hit, undefined, local)}${markText(marks.get(hit.id), hit.excerptOnly, hit.partialExcerpt === true)}\n`,
      )
      .join("")
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
        "newsletters, envelopes, drafts, suspicious senders and partial mail left out; other bulk mail after the rest, " +
        "as its subject and first lines (excerpt_only); each text without quoted earlier mail or the signature; " +
        "`messages acknowledge` moves the mark",
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
      answerLocally(this, output, answer, (local) => {
        const read = found.chats.flatMap((chat) => chat.messages)
        if (found.unanswered || found.waiting)
          output.renderer.note(
            `${[
              found.unanswered ? `owed for ${found.unanswered.olderThanHours}h or more` : "",
              found.waiting ? `waiting ${found.waiting.olderThanHours}h or more` : "",
            ]
              .filter(Boolean)
              .join(", ")}, threads active from ${local(found.since)}`,
          )
        else
          output.renderer.note(
            `from ${local(found.since)} to ${local(found.until)}${found.complete ? "" : ", incomplete"}`,
          )
        if (found.quiet > 0) output.renderer.note(`bulk:false left out ${found.quiet} threads`)
        if (read.length === 0) output.renderer.note("nothing new in the stored mail")
        return read
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
          .map((hit) => `${hitText(hit, undefined, local)}${markText(hit.marks)}\n`)
          .join("")
      })
      saved?.save(found.checked ?? {}, found.complete ? { through: found.until } : {})
    })
