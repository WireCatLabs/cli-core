import { CliError } from "@wirecat/cli-base"
import { importEngine } from "../attachments/extract.js"
import { type Level, levelFor, type PermissionKey } from "../sends/permissions.js"
import {
  type Backend,
  DEFAULT_BACKEND,
  SERVER_BOUNDS,
  SERVER_SEARCH_KEY,
  type ServerSearched,
  type ServerSkip,
  type ServerStep,
  sourceKey,
} from "../services/server-search.js"
import type { AccountKey, MessageStore, ThreadSave } from "../store/index.js"
import { MAX_ATTACHMENT_CHARS, readAttachments } from "./attachments.js"
import { bulkBox } from "./bulk.js"
import { parsedEmail } from "./email-input.js"
import { factsOf } from "./facts.js"
import { mailHeadersOf } from "./headers.js"
import { parseMail } from "./parse.js"
import { storedMailRules } from "./rule-stored.js"
import { decide } from "./rules.js"
import { type MailCriteria, mailCriteriaOf } from "./server-query.js"
import type { Listed, MailSource } from "./source.js"

/** What a run lets the server search do, read from the profile before anything is opened. */
export interface MailServerAccess {
  offline: boolean
  permissions: Readonly<Record<PermissionKey, Level>>
  defaults?: Readonly<Record<PermissionKey, Level>>
  /** `<PREFIX>_READ_ONLY`: the search writes what the server finds into the store, so it stays the archive's. */
  readOnly?: boolean
  /** The mailbox and the folders a search reads, closed after the search. */
  open: () => Promise<{ source: MailSource; folders: string[]; close?: () => Promise<void> }>
}

export interface MailServerRequest {
  text: string
  exact?: boolean
  timezone?: string
  backend?: Backend
  timeMs?: number
  signal?: AbortSignal
}

const refusal: Record<Extract<ServerSkip, "unsupported" | "offline" | "not_allowed" | "no_words">, string> = {
  unsupported: "this mailbox's server cannot be searched — use --backend archive",
  offline: "--backend server needs the network — not with --offline",
  not_allowed: "the server search is not allowed by this profile",
  no_words: "--backend server needs words, people, a subject, a date or a state to send to the server",
}

const BOUND = Symbol("bound")

type Failure = ServerSearched["failed"][number]["reason"]

/** A call the server's own deadline cut short is the time bound's, as one cut by --server-time is. */
const failureOf = (error: unknown): Failure =>
  error instanceof CliError && error.code === "rate_limited"
    ? "rate_limited"
    : error instanceof CliError && error.code === "timeout"
      ? "time_or_abort_bound"
      : "search_failed"

/** The newest first: a server's UIDs grow as mail arrives in the folder. */
const newest = (uids: readonly string[], count: number) =>
  [...uids].sort((one, other) => Number(other) - Number(one)).slice(0, count)

/**
 * Asks the mailbox's server for candidates and saves the new ones, so the strict query that runs next on the store
 * sees them: the messenger rule (cli-core docs/search/query-language.md, "Поиск на сервере мессенджера"). Each source
 * key is `sourceKey(thread, email)`. Mail a skip or envelope rule keeps out of the store is not saved. Nothing moves the
 * sync's saved position or coverage, and a reply after the time bound is dropped unsaved.
 */
export const searchMailServer = async (
  store: MessageStore,
  mailbox: AccountKey,
  access: MailServerAccess,
  request: MailServerRequest,
): Promise<ServerStep | undefined> => {
  const backend = request.backend ?? DEFAULT_BACKEND
  if (backend === "archive") return undefined
  const quiet = request.backend === undefined
  const timeMs = request.timeMs ?? SERVER_BOUNDS.timeMs
  if (!Number.isSafeInteger(timeMs) || timeMs < 1 || timeMs > 60_000)
    throw new CliError("validation_error", "the server time takes a whole number of milliseconds from 1 to 60000")
  const report: ServerSearched = { backend, skipped: null, calls: 0, returned: 0, new: 0, failed: [], complete: true }
  const sources = new Map<string, "server" | "both">()
  const skip = (reason: keyof typeof refusal): ServerStep | undefined => {
    if (quiet) return undefined
    if (backend === "server")
      throw new CliError(reason === "not_allowed" ? "permission_error" : "validation_error", refusal[reason], {
        reason,
      })
    return { report: { ...report, skipped: reason, complete: false }, sources }
  }
  if (access.offline) return skip("offline")
  // As tg's: `ask` and `readonly` give the archive's answer, since nobody is asked before a search.
  if (access.readOnly || levelFor(access.permissions, SERVER_SEARCH_KEY, access.defaults).level !== "allow")
    return skip("not_allowed")
  const { branches, partial } = mailCriteriaOf(request.text, {
    ...(request.exact ? { exact: true } : {}),
    ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
  })
  if (!branches.length) return skip("no_words")
  if (partial) report.complete = false
  const pending = new Set<{ criteria: MailCriteria; folder: string }>()
  const listed: Listed[] = []
  const validities = new Map<Listed, string>()
  let open = true
  const fail = (call: { folder: string } | null, reason: Failure) => {
    report.complete = false
    report.failed.push({ chat: call?.folder ?? null, reason })
  }
  const accountId = await store.accounts.saveAccount(mailbox, { name: mailbox.account })
  const fresh: Listed[] = []
  let raws: (Uint8Array | Error)[] | undefined
  let opening: ReturnType<MailServerAccess["open"]> | undefined
  let openFailure: unknown
  let unsupported = false

  // Opening lists the folders, a call to the server, so it runs inside the time bound too.
  const run = async () => {
    opening = access.open()
    const { source, folders } = await opening.catch((error: unknown) => {
      openFailure = error
      throw error
    })
    const query = source.query?.bind(source)
    if (!query) {
      unsupported = true
      return
    }
    const asked = branches.flatMap((criteria) => folders.map((folder) => ({ criteria, folder })))
    if (asked.length > SERVER_BOUNDS.maxCalls) report.complete = false
    const calls = asked.slice(0, SERVER_BOUNDS.maxCalls)
    for (const call of calls) pending.add(call)
    await Promise.all(
      calls.map(async (call) => {
        report.calls += 1
        try {
          const found = await query(call.criteria, call.folder)
          const uids = newest(found.uids, SERVER_BOUNDS.perCall)
          if (uids.length < found.uids.length) report.complete = false
          const items = uids.length
            ? await source.list(new Date(0), call.folder, { headers: true, searched: { ...found, uids } })
            : []
          if (!open) return
          pending.delete(call)
          listed.push(...items)
          if (found.validity) for (const item of items) validities.set(item, found.validity as string)
        } catch (error) {
          if (!open) return
          pending.delete(call)
          fail(call, failureOf(error))
        }
      }),
    )
    if (!open) return
    const unique = [...new Map(listed.map((item) => [item.messageId, item])).values()]
    const rules = await storedMailRules(store, { address: mailbox.account })
    const facts = factsOf(unique, rules)
    for (const item of unique) {
      const held = (await store.mail.email(accountId, item.messageId)) !== null
      const rule = decide(rules, facts(item))
      if (!held && (rule?.action === "skip" || rule?.action === "envelope")) continue
      report.returned += 1
      sources.set(sourceKey(item.threadId, item.messageId), held ? "both" : "server")
      if (!held) fresh.push(item)
    }
    if (fresh.length) raws = await source.fetchRaw(fresh)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeMs)
  const stop = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
  const bound = new Promise<typeof BOUND>((resolve) => {
    if (stop.aborted) resolve(BOUND)
    stop.addEventListener("abort", () => resolve(BOUND), { once: true })
  })
  let outcome: "done" | Failure | typeof BOUND
  try {
    outcome = await Promise.race([run().then(() => "done" as const, failureOf), bound])
  } finally {
    open = false
    clearTimeout(timer)
    // A late open is closed too, once it lands, so no connection outlives the answer.
    void opening?.then(
      (one) => one.close?.(),
      () => undefined,
    )
  }
  if (openFailure !== undefined && backend === "server") throw openFailure
  if (unsupported) return skip("unsupported")
  const ended = outcome === BOUND || outcome === "done" ? "time_or_abort_bound" : outcome
  for (const call of pending) fail(call, ended)
  if (outcome !== "done" || (fresh.length > 0 && raws === undefined)) {
    // What was found but not read in time is the archive's to answer: none of it is claimed as the server's.
    if (pending.size === 0) fail(null, ended)
    for (const item of fresh) sources.delete(sourceKey(item.threadId, item.messageId))
    report.returned = sources.size
    return { report, sources }
  }

  const now = Date.now()
  const inputs: ThreadSave[] = []
  for (const [index, item] of fresh.entries()) {
    const raw = raws?.[index]
    try {
      if (raw === undefined || raw instanceof Error) throw raw ?? new Error("not read")
      const mail = await parseMail(raw)
      const files = await readAttachments(
        mail,
        item.messageId,
        { loadEngine: importEngine, maxAttachmentChars: MAX_ATTACHMENT_CHARS, at: now },
        [],
      )
      const folder = item.folder as string
      const validity = validities.get(item)
      inputs.push({
        accountId,
        externalId: item.threadId,
        now,
        emails: [
          {
            ...parsedEmail(mail, item, mailHeadersOf(raw), mailbox.account),
            mailboxes: [
              { externalId: folder, name: folder, kind: null },
              ...(item.labels ?? []).map((name) => ({ externalId: `label:${name}`, name, kind: "label" })),
              ...(item.headers?.bulk ? [bulkBox] : []),
            ],
            ...(validity === undefined
              ? {}
              : { locations: [{ folder, uidvalidity: validity, uid: Number(item.uid) }] }),
            ...(item.seen === undefined ? {} : { read: item.seen }),
            ...(item.flagged === undefined ? {} : { flagged: item.flagged }),
            attachments: files,
          },
        ],
      })
    } catch {
      sources.delete(sourceKey(item.threadId, item.messageId))
      report.complete = false
    }
  }
  if (inputs.length) await store.mail.saveThreads(inputs)
  report.new = inputs.length
  report.returned = sources.size
  return { report, sources }
}
