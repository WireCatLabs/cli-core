import { CliError, type ErrorCode } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { queryFieldsOf } from "@wirecat/cli-base/query"
import { Command, InvalidArgumentError } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { outputFor } from "../../cli/context.js"
import { LOCAL_READ, REMOTE_READ } from "../../cli/effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../../cli/envelope.js"
import { listQuery, typedQuery, withQuery } from "../../cli/list-query.js"
import { messagesAnswer, offsetOf, shownOf } from "../../cli/messenger/search-answers.js"
import { backendRequest, noteServer, serverSearchOptions } from "../../cli/messenger/search-backend-options.js"
import { positiveCount } from "../../cli/paging.js"
import { formatReference, parseReference } from "../../domain/references.js"
import { count, reference, text, time, untrusted } from "../../entities/fields.js"
import type { ShownMail } from "../../mail/read.js"
import { attachmentsText, hitText, searchMail, showMail, withAttachmentText } from "../../mail/read.js"
import { type MailServerAccess, searchMailServer } from "../../mail/server-search.js"
import { atDetail } from "../../output-detail.js"
import type { AppIdentity } from "../../ports/app.js"
import { type ServerSearched, type ServerSkip, sourceKey } from "../../services/server-search.js"
import { type AccountKey, type MessageStore, queryFilter, THREAD_COLUMNS } from "../../store/store.js"

/** A locked or broken store must fail the command, not read as "nothing stored yet". */
const absentAccount = (error: unknown): undefined => {
  if (error instanceof CliError && error.code === "not_found") return undefined
  throw error
}

/** What a mail CLI hands the shared commands: how to open the store for one run, and whose mail it reads. */
export interface MailReads {
  app: AppIdentity
  /**
   * Runs `work` over the shared store as the selected profile's mailbox, and closes the store after. Every command
   * reads that mailbox alone; the store must take writes, since a search tops up its word index first.
   */
  read: <T>(command: Command, work: (store: MessageStore, mailbox: AccountKey) => Promise<T>) => Promise<T>
  /** The mailbox's server, for `search messages --backend`; without it the search reads the store only. */
  server?: (command: Command) => MailServerAccess
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

const limitOf = (value: string) => {
  const limit = positiveCount("--limit")(value)
  if (limit > MAX_LIMIT) throw new InvalidArgumentError(`at most ${MAX_LIMIT}`)
  return limit
}

const wholeCount = (value: string) => {
  if (!/^\d+$/.test(value.trim())) throw new InvalidArgumentError("expected a whole number from 0")
  return Number(value)
}

const detailOf = (command: Command): "brief" | "full" | undefined => {
  const { brief, full } = command.optsWithGlobals<{ brief?: boolean; full?: boolean }>()
  return brief ? "brief" : full ? "full" : undefined
}

/** The thread a `chat:email/…` or `msg:email/…` reference names; another mailbox's is refused. */
const threadOf = (mailbox: AccountKey, given: string): string => {
  const place = parseReference(given)
  if (place.type !== "chat" && place.type !== "message")
    throw new CliError("validation_error", `${given} names no email thread — give chat:email/… or msg:email/…`)
  if (place.provider !== mailbox.provider || place.account !== mailbox.account)
    throw new CliError("not_found", `${given} is not mail of this profile's mailbox ${mailbox.account}`)
  return place.chat
}

type Issue = { code: ErrorCode; reason: string }
const SKIPPED: Record<ServerSkip, Issue> = {
  unsupported: { code: "provider_error", reason: "search.server-unsupported" },
  pushed_history: { code: "provider_error", reason: "search.server-unsupported" },
  offline: { code: "permission_error", reason: "search.offline" },
  not_allowed: { code: "permission_error", reason: "search.server-not-allowed" },
  other_accounts: { code: "validation_error", reason: "search.server-no-criteria" },
  no_words: { code: "validation_error", reason: "search.server-no-criteria" },
  needs_chat: { code: "validation_error", reason: "search.server-no-criteria" },
}
const FAILED: Record<ServerSearched["failed"][number]["reason"], Issue> = {
  rate_limited: { code: "rate_limited", reason: "search.server-rate-limited" },
  search_failed: { code: "provider_unavailable", reason: "search.server-failed" },
  time_or_abort_bound: { code: "timeout", reason: "search.server-timeout" },
}

/** What the server search left out, so `meta.complete` is false whenever any of it is (WC-OUT-7). */
const serverIssues = (server: ServerSearched | undefined) => {
  if (!server || server.complete) return []
  if (server.skipped) return [{ ...SKIPPED[server.skipped], source: "server" }]
  const failed = [...new Set(server.failed.map(({ reason }) => reason))].map((reason) => ({
    ...FAILED[reason],
    source: "server",
  }))
  return failed.length
    ? failed
    : [{ code: "outcome_unknown" as const, reason: "search.server-capped", source: "server" }]
}

const searchCommand = (mail: MailReads): Command => {
  const leaf = annotate(new Command("messages"), {
    effects: mail.server ? REMOTE_READ : LOCAL_READ,
    partial: true,
    output: { entity: "message", view: "hit" },
    examples: [
      `${mail.app.command} personal search messages invoice`,
      `${mail.app.command} personal search messages 'from:ann@example.com has:attachment date>30d'`,
      `${mail.app.command} personal search messages 'list:github.com is:unread' --newest`,
    ],
  })
    .summary(mail.server ? "find emails by words and fields" : "find stored emails by words and fields")
    .description(
      mail.server
        ? "search this profile's mail in the local store and, by default, on the mail server for mail sync has not read " +
            "yet (--backend); the server's finds are stored, then one strict query decides; best match first"
        : "search this profile's mail in the local store — what sync read — by words, people, folders, lists and dates; best match first",
    )
    .argument("<query...>", 'strict Lucene query: words, "phrases", AND/OR/NOT, field:value and date ranges')
    .option("--limit <n>", `how many, at most ${MAX_LIMIT}`, limitOf)
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--newest", "newest first instead of best first")
    .option("--exact", "bare words and quotes match their exact form only, as exact:word does")
    .option("--plain-order", "best first by the words alone, without moving mail from suspicious senders down")
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .addHelpText(
      "after",
      `
Fields: from: to: cc: bcc: subject: body: mailbox: (or label:) list: (a List-Id or its domain) is:unread|read|starred
has:attachment, filename:, content: (the text of attachments), size>, date: — \`${mail.app.command} personal search messages 'content:invoice'\`.
chat: names a thread by its subject. Mail sent to many is in the mailbox bulk; NOT mailbox:bulk leaves it out.
Mail from senders with signs of fraud comes after the rest of the page; --plain-order keeps it in place.
--json: the list is items; each hit's reference is ref (msg:email/…), which messages show reads.${
        mail.server
          ? `
--backend: the server is asked for words, from: to: cc: subject: body: is: and date:, in INBOX, Sent and Archive or
all of Gmail; the rest stays with the strict query on the store. Permission key: messages.server-search.
found_in says archive, server (new from the server) or both; meta.complete is false when the server answered in part.`
          : ""
      }
Search guide: https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md`,
    )
  if (mail.server) serverSearchOptions(leaf, "the mail server (default: both)")
  leaf.action(async function (this: Command, words: string[]) {
    const options = this.opts<{
      limit?: number
      page?: number
      newest?: boolean
      exact?: boolean
      plainOrder?: boolean
      timezone?: string
    }>()
    const limit = options.limit ?? DEFAULT_LIMIT
    const page = options.page ?? 1
    const query = words.join(" ")
    const { backend, server: bounds } = mail.server ? backendRequest(this) : {}
    const found = await mail.read(this, async (store, mailbox) => {
      const step = mail.server
        ? await searchMailServer(store, mailbox, mail.server(this), {
            text: query,
            ...(backend === undefined ? {} : { backend }),
            ...(bounds?.timeMs === undefined ? {} : { timeMs: bounds.timeMs }),
            ...(options.exact ? { exact: true } : {}),
            ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
          })
        : undefined
      const only =
        backend === "server" && step
          ? [...step.sources.keys()].map((key) => {
              const [chatId, id] = JSON.parse(key) as [string, string]
              return { ...mailbox, chatId, id }
            })
          : undefined
      const found = await searchMail(
        store,
        mailbox,
        {
          text: query,
          limit,
          mailAccount: mailbox.account,
          ...(offsetOf(page, limit) === undefined ? {} : { offset: offsetOf(page, limit) }),
          ...(options.newest ? { newest: true } : {}),
          ...(options.exact ? { exact: true } : {}),
          ...(options.plainOrder ? { plainOrder: true } : {}),
          ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
          ...(only ? { only } : {}),
        },
        { app: mail.app },
      )
      if (!step) return found
      return {
        ...found,
        server: step.report,
        items: found.items.map((hit) => ({
          ...hit,
          source: step.sources.get(sourceKey(hit.chatId, hit.id)) ?? ("archive" as const),
        })),
      }
    })
    const output = outputFor(this)
    const again = {
      query,
      ...(options.newest ? { newest: true } : {}),
      ...(options.exact ? { exact: true } : {}),
      ...(options.plainOrder ? { plain_order: true } : {}),
      ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    }
    const level = detailOf(this)
    const answer = messagesAnswer("search messages", found, { limit, page, again }, query)
    const issues = serverIssues(found.server)
    if (issues.length)
      answer.meta = { ...answer.meta, complete: false, issues: [...(answer.meta?.issues ?? []), ...issues] }
    renderAnswer(this, output, answer, () => {
      if (!found.wordsReady)
        output.renderer.note(`the word index is still being built — \`${mail.app.command} store migrate\` finishes it`)
      noteServer(output, found.server)
      if (found.items.length === 0)
        output.renderer.note(
          found.server && !found.server.skipped
            ? "nothing found in the local store or on the mail server"
            : "nothing found — only mail sync stored is searched",
        )
      const shown = shownOf(found.items.length, (page - 1) * limit, found.total)
      if (shown) output.renderer.note(shown)
      return found.items.map((item) => `${hitText(item, level)}\n`).join("")
    })
  })
  return new Command("search").summary("search the stored mail").description("find stored emails").addCommand(leaf)
}

const shownText = (emails: ShownMail[]) =>
  `${emails.map((email) => [hitText(email, "full"), attachmentsText(email)].filter(Boolean).join("\n")).join("\n\n")}\n`

const messagesCommand = (mail: MailReads): Command => {
  const messages = new Command("messages").summary("read stored emails").description("read the emails sync stored")
  annotate(messages.command("show"), {
    effects: LOCAL_READ,
    examples: [
      `${mail.app.command} personal messages show 'msg:email/me%40example.com/thread-1/%3Cid%40example.com%3E'`,
      `${mail.app.command} personal messages show 'msg:email/me%40example.com/thread-1/%3Cid%40example.com%3E' --before-n 2`,
    ],
  })
    .summary("one stored email whole, with the text of its attachments")
    .description(
      "one stored email: its people, folders, whole text and the first 4000 characters of each attachment's text; " +
        "--full gives all of it and the HTML body. The store keeps text, not the original message source",
    )
    .argument("<message>", "the msg:email/… reference a search gives")
    .option("--before-n <n>", "also this many earlier emails of its thread", wholeCount, 0)
    .option("--after-n <n>", "also this many later emails of its thread", wholeCount, 0)
    .action(async function (this: Command, reference: string) {
      const { beforeN, afterN } = this.opts<{ beforeN: number; afterN: number }>()
      const full = detailOf(this) === "full"
      const emails = await mail.read(this, async (store, mailbox) => {
        threadOf(mailbox, reference)
        return showMail(store, reference, { before: beforeN, after: afterN, full })
      })
      const output = outputFor(this)
      const shown = emails.map((email) => snakeKeys(atDetail(email)))
      renderAnswer(
        this,
        output,
        beforeN || afterN
          ? listOf("messages show", { items: shown, limit: Math.max(1, shown.length), has_more: false })
          : itemOf(shown.find((_, at) => emails[at]?.anchor) ?? shown[0]),
        () => shownText(emails),
      )
    })
  return messages
}

const mailThread = v.strictObject({
  /** The thread as a `chat:email/…` reference, which `conversations show` takes. */
  ref: reference,
  subject: v.nullable(text),
  emails_count: count,
  last_email_at: v.nullable(time),
  untrusted,
})

export const THREAD_QUERY = {
  entity: "mail_thread",
  backend: "sql",
  fields: queryFieldsOf(mailThread, {
    exclude: ["ref", "untrusted"],
    text: ["subject"],
    examples: { subject: "subject:invoice", emails_count: "emails_count>2", last_email_at: "last_email_at>7d" },
  }),
} as const

const conversationsCommand = (mail: MailReads): Command => {
  const conversations = new Command("conversations")
    .summary("email threads")
    .description("the threads of the stored mail: an email and its replies")
  const list = withQuery(
    annotate(conversations.command("list"), {
      effects: LOCAL_READ,
      examples: [
        `${mail.app.command} personal conversations list`,
        `${mail.app.command} personal conversations list subject:invoice emails_count>1`,
      ],
    })
      .summary("stored email threads, newest first")
      .description("this profile's email threads, the newest activity first: subject, how many emails, when"),
    THREAD_QUERY,
  )
    .option("--limit <n>", `how many, at most ${MAX_LIMIT}`, limitOf)
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .action(async function (this: Command, words: string[]) {
      const options = this.opts<{ limit?: number; page?: number }>()
      const limit = options.limit ?? DEFAULT_LIMIT
      const page = options.page ?? 1
      const typed = typedQuery(words)
      const query = listQuery(typed, THREAD_QUERY, "conversations list")
      const { threads, mailbox } = await mail.read(this, async (store, mailbox) => {
        const account = await store.accounts.storedAccount(mailbox).catch(absentAccount)
        if (!account) return { threads: [], mailbox }
        const where = query ? queryFilter(query, THREAD_COLUMNS, { command: "conversations list" }) : undefined
        const threads = await store.mail.threads({
          accountId: account.id,
          limit: limit + 1,
          offset: (page - 1) * limit,
          ...(where ? { where } : {}),
        })
        return { threads, mailbox }
      })
      const items = threads.slice(0, limit).map((thread) => ({
        ref: formatReference({ type: "chat", ...mailbox, chat: thread.externalId }),
        subject: thread.subject,
        emails_count: thread.emailsCount,
        last_email_at: thread.lastEmailAt === null ? null : new Date(thread.lastEmailAt).toISOString(),
        untrusted: ["subject"],
      }))
      renderAnswer(
        this,
        outputFor(this),
        listOf("conversations list", {
          items,
          limit,
          has_more: threads.length > limit,
          page,
          ...(typed.trim() ? { args: { query: typed } } : {}),
        }),
        () =>
          items
            .map(
              (one) =>
                `${one.ref}\n  ${one.last_email_at ?? "time unknown"}  ${one.emails_count}  ${one.subject ?? ""}\n`,
            )
            .join(""),
      )
    })
  answerEntity(list, "mail_thread", mailThread)

  annotate(conversations.command("show"), {
    effects: LOCAL_READ,
    examples: [
      `${mail.app.command} personal conversations show 'chat:email/me%40example.com/thread-1'`,
      `${mail.app.command} personal conversations show 'msg:email/me%40example.com/thread-1/%3Cid%40example.com%3E'`,
    ],
  })
    .summary("one email thread, every email oldest first")
    .description("every stored email of one thread, oldest first, each with the text of its attachments")
    .argument("<conversation>", "a chat:email/… thread from conversations list, or a msg:email/… email in it")
    .action(async function (this: Command, given: string) {
      const full = detailOf(this) === "full"
      const emails = await mail.read(this, async (store, mailbox) => {
        const thread = threadOf(mailbox, given)
        const account = await store.accounts.storedAccount(mailbox).catch(absentAccount)
        const hits = account ? await store.mail.threadHits(account.id, thread) : []
        if (!account || hits.length === 0) throw new CliError("not_found", `no stored thread ${given}`)
        return Promise.all(
          hits.map(async (hit) =>
            hit.attachments?.length
              ? withAttachmentText(hit, (await store.mail.email(account.id, hit.id))?.attachments ?? [], full)
              : hit,
          ),
        )
      })
      const items = emails.map((email) => snakeKeys(atDetail(email)))
      renderAnswer(
        this,
        outputFor(this),
        listOf("conversations show", { items, limit: Math.max(1, items.length), has_more: false }),
        () => shownText(emails),
      )
    })
  return conversations
}

/**
 * `search messages`, `messages show` and `conversations list|show` over the mail a mail CLI stored: the same
 * query language, ranking and answers as memo's mail search, read only, scoped to the profile's mailbox.
 */
export const mailReadCommands = sharedCommand((mail: MailReads): Command[] => [
  searchCommand(mail),
  messagesCommand(mail),
  conversationsCommand(mail),
])
