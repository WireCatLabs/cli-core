import { CliError } from "@wirecat/cli-base"
import { extractText, importEngine } from "../attachments/extract.js"
import type { BudgetStop, RunBudget } from "../background/budget.js"
import type { LoadEngine } from "../readers/types.js"
import type { AccountKey, AttachmentInput, EmailAddress, MessageStore } from "../store/index.js"
import { BULK, bulkBox } from "./bulk.js"
import { factsOf } from "./facts.js"
import { GMAIL_ALL_MAIL, mailFolders } from "./folders.js"
import { dropMissing, tooManyGone } from "./gone.js"
import { mailHeadersOf } from "./headers.js"
import { type Address, MAX_BODY_CHARS, type ParsedMail, parseMail } from "./parse.js"
import {
  FULL_PASS_MS,
  MBOX_RESUME,
  type MboxPoint,
  mergeRanges,
  parsePoint,
  type Ranges,
  type ResumePoint,
  rangesOf,
  resumeKey,
  rulesKey,
  within,
} from "./resume.js"
import { ruleTagger, settleRuleTags, type TagOutcome } from "./rule-tags.js"
import { decide, ENVELOPE, envelopeBox, envelopeBoxOf, type MailRule, tagsOf } from "./rules.js"
import type { DomainAge } from "./score.js"
import type { Listed, MailSource, Searched } from "./source.js"

export interface MailAccount {
  /** The mailbox address: the store's account id. */
  address: string
  mode?: "gmail" | "imap" | "mbox"
  folders?: string[]
  rules?: MailRule[]
}

/** What an index step reports, as memo's embedding does; the sync only passes it on. */
export interface MailIndexed {
  chats: number
  chunks: number
  left: boolean
  notEmbedded?: unknown
}

export interface MailSyncResult {
  account: string
  since: string
  listed: number
  saved: number
  alreadyStored: number
  /** New emails a skip rule kept out: never read, never stored. */
  skipped: number
  /** New emails an envelope rule recorded: sender, date, size and labels, never their text. */
  envelopes: number
  deleted: number
  /** False when `max` stopped the run before every new message was read; the next run continues. */
  complete: boolean
  /** `partial`: a budgeted run stopped before the whole window was read; the next run goes on. */
  state?: "partial" | "complete"
  /** Why a budgeted run stopped early: its request budget, its deadline, or a cancel. */
  stopped?: BudgetStop
  /** Messages of the window this run did not get to read; a budgeted run only. */
  remaining?: number
  /** Requests a budgeted run spent. */
  requests?: number
  /** Emails that could not be read or parsed; they are tried again next run. */
  unreadable?: { message: string; reason: string }[]
  /** Why stored messages missing at the source were left alone, when they were. */
  deletionsSkipped?: string
  /** "resumed": only mail not done before was listed; "full": every message in the window was. */
  pass?: "full" | "resumed"
  indexed?: MailIndexed
  coverage?: { folders: string[]; since: string; until: string; state: "window" | "partial"; identity: string }
  attachments?: { message: string; part: number; status: string }[]
  /** Rule tags put on mail as an existing label the store pointed to. */
  tagsReused?: TagOutcome["reused"]
  /** Rule tags the store refused with nothing to reuse; that mail is stored untagged. */
  tagsSkipped?: TagOutcome["skipped"]
  /** `--retry-attachments`: emails read again for attachments a missing reader left unread. */
  retried?: { emails: number; extracted: number; stillFailed: number; missing: number }
}

const DAY = 86_400_000
/** IMAP's SINCE counts whole days in the server's zone, so the window's first days are not trusted. */
const EDGE = 2 * DAY
export const MAX_ATTACHMENT_CHARS = 200_000
/** One chunk of raw mail is held in memory at a time. */
const FETCH_CHUNK = 50
/** How often a long run saves where it is, so a kill costs at most this much listing again. */
const SAVE_EVERY_MS = 30_000
/** About a minute of listing; the 30-day window of the timer stays below it. */
const RESUME_FROM = 5_000

const addressOf = ({ email, name }: Address): EmailAddress => ({ address: email, name })

type AttachmentLog = NonNullable<MailSyncResult["attachments"]>

/** A parsed email's attachments as the store keeps them, each with its text or why it has none. */
const readAttachments = async (
  mail: ParsedMail,
  messageId: string,
  { loadEngine, maxAttachmentChars, at }: { loadEngine: LoadEngine; maxAttachmentChars: number; at: number },
  log: AttachmentLog,
): Promise<AttachmentInput[]> => {
  const files: AttachmentInput[] = []
  for (const [position, part] of mail.attachments.entries()) {
    const extraction =
      part.bytes === null
        ? { status: "unavailable" as const }
        : await extractText(part.bytes, { kind: "file", name: part.name, mime: part.mime, path: part.name }, loadEngine)
    log.push({ message: messageId, part: part.id, status: extraction.status })
    const extracted = extraction.status === "extracted" ? extraction : undefined
    files.push({
      position,
      kind: "file",
      mime: part.mime,
      name: part.name,
      title: null,
      url: null,
      size: part.bytes === null ? null : part.bytes.byteLength,
      width: null,
      height: null,
      duration: null,
      providerRef: { message: messageId, part: part.id },
      localPath: null,
      text: extracted ? extracted.text.slice(0, maxAttachmentChars) : null,
      normalizedText: null,
      extraction: extracted ? "text" : "failed",
      extractor: extracted ? extracted.extractor : null,
      extractionError: extracted ? null : extraction.status,
      contentSha256: null,
      extractedAt: at,
    })
  }
  return files
}

export interface MailSyncOptions {
  account: MailAccount
  since: Date
  max?: number
  maxBodyChars?: number
  maxAttachmentChars?: number
  now?: () => number
  /** Domain registration dates already known, for the sender score a rule asks for. */
  ages?: ReadonlyMap<string, DomainAge>
  loadEngine?: LoadEngine
  retryAttachments?: boolean
  /** List every message in the window, not only those an earlier run left: proves deletions, refreshes labels. */
  rescan?: boolean
  /** A window smaller than this is listed whole every run: it costs seconds and keeps flags and deletions current. */
  resumeFrom?: number
  /** Runs after the mail is saved, so chats and mail still waiting for vectors are indexed; its answer is `indexed`. */
  index?: (store: MessageStore, key: AccountKey) => Promise<MailIndexed>
  /** Stops between batches of emails, after saving the resume point. */
  signal?: AbortSignal
  /**
   * Makes the run budgeted: it reads the window in rounds, one request of the budget per call to the source, saves
   * after each, stops when the budget says so and answers `state: "partial"`. A message the source could not give
   * is tried once more at the end of the run and, if it still fails, left for the next one. `max` defaults to no limit.
   */
  budget?: RunBudget
}

/** What a budgeted run carries from one round to the next. */
interface Plan {
  budget: RunBudget
  /** UIDs a round already asked for, `folder\0uid`: a failing message is not asked for again in the same pass. */
  tried: Set<string>
  /** Messages the source could not give; asked for once more when the pass is over. */
  failed: Set<string>
  /** Only these are asked for: the retry pass. */
  only?: Set<string>
  searches: Map<string, Searched>
  /** Each folder's mode, fixed in the first round: `resumed` asks for what is not done, `full` for everything. */
  modes: Map<string, "resumed" | "full">
  unreadable: Map<string, string>
  /** UIDs the source did not return at all, as the keys of `failed`. */
  unlisted: Set<string>
  stopped: BudgetStop | null
  /** Messages in the window not asked for yet, after the round. */
  remaining: number
  /** Messages the round asked the source for. */
  asked: number
}

const LIST_SLICE = 200
const FETCH_SLICE = 50
const keyOf = (folder: string, uid: string) => `${folder}\0${uid}`

export const syncMail = async (
  source: MailSource,
  store: MessageStore,
  options: MailSyncOptions,
): Promise<MailSyncResult> => {
  const { budget, index } = options
  if (budget === undefined || options.retryAttachments || options.account.mode === "mbox")
    return syncRound(source, store, options)
  const plan: Plan = {
    budget,
    tried: new Set(),
    failed: new Set(),
    searches: new Map(),
    modes: new Map(),
    unreadable: new Map(),
    unlisted: new Set(),
    stopped: null,
    remaining: 0,
    asked: 0,
  }
  const rounds: MailSyncResult[] = []
  const goOn = async () => {
    for (;;) {
      plan.asked = 0
      plan.remaining = 0
      try {
        rounds.push(
          await syncRound(
            source,
            store,
            { ...options, index: undefined, max: options.max ?? Number.POSITIVE_INFINITY },
            plan,
          ),
        )
      } catch (error) {
        // A request cut at the deadline, or failed after the budget was spent, is the run's end, not its failure: what
        // earlier rounds saved is kept and the next run goes on. While the budget has room the error is real.
        const transient = error instanceof CliError && (error.code === "timeout" || error.code === "network_error")
        const stop = transient && rounds.length > 0 ? budget.take() : null
        if (stop === null) throw error
        plan.stopped = stop
        plan.remaining = Math.max(plan.remaining, 1)
        return
      }
      if (plan.stopped !== null || plan.remaining === 0) return
    }
  }
  await goOn()
  const remaining = plan.remaining
  // A message the server failed on once is often fine a minute later; only one more try, then the next run.
  if (plan.stopped === null && plan.failed.size > 0) {
    plan.only = new Set(plan.failed)
    plan.failed.clear()
    plan.tried.clear()
    await goOn()
  }
  const last = rounds.at(-1) as MailSyncResult
  const sum = (pick: (round: MailSyncResult) => number) => rounds.reduce((total, round) => total + pick(round), 0)
  const unreadable = [
    ...[...plan.unreadable].map(([message, reason]) => ({ message, reason })),
    ...[...plan.unlisted].map((key) => ({
      message: `uid:${key.replace("\0", ":")}`,
      reason: "the server did not return it",
    })),
  ]
  const complete = last.complete && plan.stopped === null && unreadable.length === 0 && remaining === 0
  const account: AccountKey = { provider: "email", account: options.account.address.toLowerCase() }
  const indexed = plan.stopped === null ? await index?.(store, account) : undefined
  const deletionsSkipped = rounds.map((round) => round.deletionsSkipped).findLast((text) => text !== undefined)
  const { unreadable: _unreadable, ...rest } = last
  return {
    ...rest,
    listed: sum((round) => round.listed),
    saved: sum((round) => round.saved),
    alreadyStored: sum((round) => round.alreadyStored),
    skipped: sum((round) => round.skipped),
    envelopes: sum((round) => round.envelopes),
    deleted: sum((round) => round.deleted),
    complete,
    state: complete ? "complete" : "partial",
    remaining,
    requests: budget.used,
    ...(plan.stopped === null ? {} : { stopped: plan.stopped }),
    ...(indexed === undefined ? {} : { indexed }),
    ...(unreadable.length ? { unreadable } : {}),
    ...(deletionsSkipped === undefined ? {} : { deletionsSkipped }),
    ...(rounds.some((round) => round.pass === "resumed") ? { pass: "resumed" as const } : {}),
    ...(rounds.some((round) => round.attachments)
      ? { attachments: rounds.flatMap((round) => round.attachments ?? []) }
      : {}),
    ...(rounds.some((round) => round.tagsReused)
      ? { tagsReused: rounds.flatMap((round) => round.tagsReused ?? []) }
      : {}),
    ...(rounds.some((round) => round.tagsSkipped)
      ? { tagsSkipped: rounds.flatMap((round) => round.tagsSkipped ?? []) }
      : {}),
  }
}

const syncRound = async (
  source: MailSource,
  store: MessageStore,
  {
    account,
    since,
    max = 200,
    maxBodyChars = MAX_BODY_CHARS,
    maxAttachmentChars = MAX_ATTACHMENT_CHARS,
    now = Date.now,
    ages,
    loadEngine = importEngine,
    retryAttachments = false,
    rescan = false,
    resumeFrom = RESUME_FROM,
    index,
    signal,
  }: MailSyncOptions,
  plan?: Plan,
): Promise<MailSyncResult> => {
  if (retryAttachments)
    return retryUnread({
      store,
      source,
      account,
      since,
      max,
      maxBodyChars,
      maxAttachmentChars,
      now,
      loadEngine,
      index,
    })
  const startedAt = now()
  const key: AccountKey = { provider: "email", account: account.address.toLowerCase() }
  const accountId = await store.accounts.saveAccount(key, { name: account.address })

  const folders = await mailFolders(account, source)
  if (folders.length < 1 || folders.length > 50) throw new Error("select 1–50 mail folders")
  const rules = account.rules ?? []
  // An archive file is a snapshot of the same account: it adds mail, and changes nothing IMAP keeps current.
  const snapshot = account.mode === "mbox"
  const ruleSet = rulesKey(rules)
  const collected: Listed[] = []
  const searches = new Map<string, Searched>()
  /** The earlier point of each folder whose UIDs and rules still hold; its done mail stays done. */
  const earlier = new Map<string, ResumePoint>()
  /** Every folder's stored point, valid or not: the widest window outlives what invalidates the rest. */
  const storedPoints = new Map<string, ResumePoint>()
  const resumed = new Set<string>()
  let mboxPoint: MboxPoint | undefined
  let mboxStamp: Awaited<ReturnType<NonNullable<MailSource["stamp"]>>> | undefined
  // A rerun lists only what the last left; --rescan, a rule change or a new UIDVALIDITY lists everything again.
  const fresh = rescan
  if (snapshot && source.stamp !== undefined) {
    mboxStamp = await source.stamp()
    const point = fresh ? undefined : parsePoint<MboxPoint>((await store.sync.syncState(key, MBOX_RESUME))?.value)
    if (point?.complete && point.size === mboxStamp.size && point.mtimeMs === mboxStamp.mtimeMs) mboxPoint = point
  }
  let capped = false
  for (const folder of folders) {
    if (mboxPoint !== undefined) break
    let searched: Searched | undefined
    if (source.search !== undefined && !snapshot) {
      searched = plan?.searches.get(folder)
      if (searched === undefined) {
        const stop = plan?.budget.take()
        if (plan && stop) {
          plan.stopped = stop
          capped = true
          continue
        }
        searched = await source.search(since, folder)
        plan?.searches.set(folder, searched)
      }
    }
    let wanted = searched
    if (searched !== undefined) {
      searches.set(folder, searched)
      const kept = parsePoint<ResumePoint>((await store.sync.syncState(key, resumeKey(folder)))?.value)
      if (kept !== undefined) storedPoints.set(folder, kept)
      const point = fresh ? undefined : kept
      if (point !== undefined && point.validity === searched.validity && point.rules === ruleSet) {
        earlier.set(folder, point)
        const mode = plan?.modes.get(folder)
        const usable =
          Date.parse(point.full.since) <= since.getTime() && startedAt - Date.parse(point.full.at) < FULL_PASS_MS
        // A budgeted run goes on with an unfinished pass however small its window is: listing it whole again would
        // ask for the same newest messages every run.
        const unfinished = plan !== undefined && searched.uids.some((uid) => !within(point.done, Number(uid)))
        if (
          mode === "resumed" ||
          (mode === undefined && usable && (searched.uids.length >= resumeFrom || unfinished))
        ) {
          resumed.add(folder)
          wanted = { ...searched, uids: searched.uids.filter((uid) => !within(point.done, Number(uid))) }
        }
      }
      if (plan !== undefined) {
        plan.modes.set(folder, resumed.has(folder) ? "resumed" : "full")
        const open = (wanted as Searched).uids.filter((uid) =>
          plan.only
            ? plan.only.has(keyOf(folder, uid)) && !plan.tried.has(keyOf(folder, uid))
            : !plan.tried.has(keyOf(folder, uid)),
        )
        const slice = [...open].sort((a, b) => Number(b) - Number(a)).slice(0, source.listBatch ?? LIST_SLICE)
        plan.remaining += open.length - slice.length
        wanted = { ...searched, uids: slice }
        if (open.length > slice.length) capped = true
      }
    }
    if (plan !== undefined && wanted !== undefined && wanted.uids.length === 0) continue
    if (plan !== undefined) {
      const stop = plan.budget.take()
      if (stop) {
        plan.stopped = stop
        capped = true
        plan.remaining += (wanted as Searched).uids.length
        continue
      }
      for (const uid of (wanted as Searched).uids) plan.tried.add(keyOf(folder, uid))
      plan.asked += (wanted as Searched).uids.length
    }
    const found = await source.list(since, folder, {
      headers: rules.length > 0,
      ...(wanted === undefined ? {} : { searched: wanted }),
    })
    if (plan !== undefined && wanted !== undefined) {
      const got = new Set(found.map(({ uid }) => uid))
      for (const uid of wanted.uids) {
        const key = keyOf(folder, uid)
        if (got.has(uid)) plan.unlisted.delete(key)
        else {
          plan.failed.add(key)
          plan.unlisted.add(key)
        }
      }
    }
    // Spreading a whole mailbox into push() overflows the stack past ~120,000 emails.
    for (const item of found) collected.push(item)
  }
  const listed = [...new Map(collected.map((item) => [item.messageId, item])).values()].sort((a, b) =>
    b.receivedAt.localeCompare(a.receivedAt),
  )
  const present = new Set(listed.map(({ messageId }) => messageId))
  const factsFor = factsOf(listed, rules, ages)
  // A rule's tag goes on mail this run stores or records; mail stored earlier gets it from memo mail rules apply.
  const tagger = ruleTagger(store, key)
  const tagStored = async (item: Listed) => {
    const tags = tagsOf(rules, factsFor(item))
    if (tags.length) await tagger.tag({ type: "message", chatId: item.threadId, messageId: item.messageId }, tags)
  }
  const foundFolders = new Map<string, Set<string>>()
  for (const item of collected) {
    const current = foundFolders.get(item.messageId) ?? new Set<string>()
    current.add(item.folder ?? (folders[0] as string))
    foundFolders.set(item.messageId, current)
  }
  const mailbox = (folder: string) => ({ externalId: folder, name: folder, kind: null })
  const label = (name: string) => ({ externalId: `label:${name}`, name, kind: "label" })
  const labelsOf = new Map(collected.flatMap((item) => (item.labels === undefined ? [] : [[item.messageId, item]])))
  const allMailOnly =
    account.mode !== "imap" && folders.length === 1 && (account.folders === undefined || folders[0] === GMAIL_ALL_MAIL)

  // Deletions are proved against the mailboxes as stored before this scan moves anything.
  const scope = JSON.stringify({ mode: account.mode ?? "gmail", folders: [...folders].sort() })
  const previousScope = snapshot ? undefined : await store.sync.syncState(key, "mail_folder_scope")
  const windowStart = new Date(since.getTime() + EDGE)
  let deleted = 0
  let skipped: string | undefined
  if (snapshot) skipped = "an mbox file is a snapshot; mail missing from it is not proven deleted"
  else if (plan !== undefined && (capped || plan.tried.size > plan.asked || plan.only !== undefined))
    skipped = "this run read the window in parts; a run that lists all of it at once checks deletions"
  else if (resumed.size > 0)
    skipped =
      "this run listed only mail not read before; a full listing, at least daily or with --rescan, checks deletions"
  else if (previousScope !== undefined && previousScope.value !== scope)
    skipped = "folder scope changed; missing mail is not proven deleted"
  else {
    // A label is not where mail lives, so only folders prove that a missing mail was deleted.
    const candidates = (await store.mail.emailRefs({ accountId, since: windowStart.getTime() })).filter(
      ({ mailboxes }) => {
        const inFolders = mailboxes.filter(({ kind }) => kind !== "label" && kind !== ENVELOPE && kind !== BULK)
        return inFolders.length ? inFolders.every(({ externalId }) => folders.includes(externalId)) : allMailOnly
      },
    )
    const gone = candidates.filter(({ externalId }) => !present.has(externalId)).map(({ externalId }) => externalId)
    skipped = tooManyGone(gone.length, candidates.length)
    if (!skipped && gone.length) deleted = await store.mail.markDeleted(accountId, gone, startedAt)
    // Mail an earlier import saved as messages keeps the rule it was saved under until those rows are removed.
    const older = await dropMissing(
      store,
      key,
      { has: (id) => present.has(id.replace(/:attachment:\d+$/, "")) },
      windowStart.toISOString(),
      async ({ id }) => {
        const membership = await store.sync.syncState(key, `mail_message_folders:${id.replace(/:attachment:\d+$/, "")}`)
        if (membership === undefined) return allMailOnly
        return (JSON.parse(membership.value) as string[]).every((folder) => folders.includes(folder))
      },
    )
    deleted += older.deleted
    skipped ??= older.skipped
  }
  if (!snapshot)
    await store.mail.setMailboxes(
      accountId,
      folders.map(mailbox),
      new Map([...foundFolders].map(([id, found]) => [id, [...found]])),
      startedAt,
    )
  // A message's label list is whole, so every label the account has is replaced for each message read.
  if (labelsOf.size && !snapshot) {
    const known = (await store.mail.mailboxes(accountId)).filter(({ kind }) => kind === "label")
    const seen = [...labelsOf.values()].flatMap(({ labels }) => labels ?? [])
    const scanned = new Map([
      ...known.map(({ name }) => [name, label(name)] as const),
      ...seen.map((name) => [name, label(name)] as const),
    ])
    await store.mail.setMailboxes(
      accountId,
      [...scanned.values()],
      new Map([...labelsOf].map(([id, { labels }]) => [id, (labels ?? []).map((name) => label(name).externalId)])),
      startedAt,
    )
  }

  const attachments: NonNullable<MailSyncResult["attachments"]> = []
  const unreadable: NonNullable<MailSyncResult["unreadable"]> = []
  let saved = 0
  let alreadyStored = 0
  let ruledOut = 0
  let envelopes = 0
  const pending: Listed[] = []
  // IMAP lists what exists now, so a mail marked deleted that it lists again is saved again, which brings it back.
  // An archive is old: what it holds that IMAP proved deleted stays deleted.
  const refs = await store.mail.emailRefs({ accountId, includeDeleted: snapshot })
  const known = new Set(refs.map(({ externalId }) => externalId))

  const enveloped = new Map(
    refs.flatMap(({ externalId, mailboxes }) => {
      const boxes = mailboxes.filter(({ kind }) => kind === ENVELOPE).map((box) => box.externalId)
      return boxes.length ? [[externalId, boxes] as const] : []
    }),
  )
  const upgraded = new Map<string, string[]>()
  const toRecord: { item: Listed; rule: MailRule }[] = []
  // Mail whose outcome is final under these rules; only these UIDs are skipped by the next run's listing.
  const settled = new Set<string>()
  let full = false
  for (const item of listed) {
    const rule = decide(rules, factsFor(item))
    const boxes = enveloped.get(item.messageId)
    // An envelope whose rule is gone or now keeps the mail is read in full; one a skip now matches stays as it is.
    if (boxes !== undefined && rule?.action !== ENVELOPE && rule?.action !== "skip") {
      if (pending.length < max) {
        upgraded.set(item.messageId, boxes)
        pending.push(item)
      } else full = true
      continue
    }
    if (known.has(item.messageId)) {
      alreadyStored++
      settled.add(item.messageId)
      continue
    }
    // Stored mail a newer skip or envelope rule matches stays whole: removing it is a separate, explicit step.
    if (rule?.action === "skip") {
      ruledOut++
      settled.add(item.messageId)
      continue
    }
    if (rule?.action === ENVELOPE) {
      if (!known.has(item.messageId)) toRecord.push({ item, rule })
      else {
        alreadyStored++
        settled.add(item.messageId)
      }
      continue
    }
    if (pending.length < max) pending.push(item)
    else full = true
  }
  const inMailboxes = (item: Listed) => [
    ...[...(foundFolders.get(item.messageId) ?? [])].map(mailbox),
    ...(labelsOf.get(item.messageId)?.labels ?? []).map(label),
  ]
  const flagsOf = (item: Listed) => {
    const { seen, flagged } = labelsOf.get(item.messageId) ?? {}
    return { ...(seen === undefined ? {} : { read: seen }), ...(flagged === undefined ? {} : { flagged }) }
  }
  const uidsOf = new Map<string, Map<string, number[]>>()
  for (const item of collected) {
    const folder = item.folder ?? (folders[0] as string)
    if (!searches.has(folder)) continue
    const inFolder = uidsOf.get(folder) ?? new Map<string, number[]>()
    inFolder.set(item.messageId, [...(inFolder.get(item.messageId) ?? []), Number(item.uid)])
    uidsOf.set(folder, inFolder)
  }
  const saveProgress = async () => {
    for (const [folder, searched] of searches) {
      if (searched.validity === undefined) continue
      const done: number[] = []
      for (const [messageId, uids] of uidsOf.get(folder) ?? []) if (settled.has(messageId)) done.push(...uids)
      const before = earlier.get(folder)
      // A narrower whole listing, like the timer's 30 days, does not replace a wider one that is still fresh.
      const keepFull =
        before !== undefined &&
        (resumed.has(folder) ||
          (Date.parse(before.full.since) < since.getTime() && startedAt - Date.parse(before.full.at) < FULL_PASS_MS))
      const merged = mergeRanges(before?.done ?? ([] as Ranges), rangesOf(done))
      const widest = before === undefined || since.getTime() <= Date.parse(before.window.since)
      const thisRun = { since: since.toISOString(), total: searched.uids.length, at: new Date(startedAt).toISOString() }
      const prior = storedPoints.get(folder)
      const priorWidest =
        prior?.widest ??
        (prior === undefined
          ? undefined
          : { since: prior.window.since, total: prior.window.total, at: prior.updatedAt })
      const widestEver =
        priorWidest === undefined || since.getTime() <= Date.parse(priorWidest.since) ? thisRun : priorWidest
      const point: ResumePoint = {
        validity: searched.validity,
        done: merged,
        rules: ruleSet,
        full: keepFull ? before.full : { since: since.toISOString(), at: new Date(startedAt).toISOString() },
        window: widest
          ? {
              since: since.toISOString(),
              total: searched.uids.length,
              done: searched.uids.filter((uid) => within(merged, Number(uid))).length,
            }
          : before.window,
        widest: widestEver,
        last: { ...thisRun, done: searched.uids.filter((uid) => within(merged, Number(uid))).length },
        updatedAt: new Date(now()).toISOString(),
      }
      await store.sync.setSyncState(key, resumeKey(folder), JSON.stringify(point))
    }
  }
  let savedAt = now()
  const saveNow = async (force = false) => {
    if (!force && now() - savedAt < SAVE_EVERY_MS) return
    savedAt = now()
    await saveProgress()
  }
  const stopIfAborted = async () => {
    if (!signal?.aborted) return
    await saveNow(true)
    throw signal.reason
  }
  await saveNow(true)

  // An envelope costs nothing more from the source: its fields were read with the listing.
  for (const { item, rule } of toRecord) {
    await stopIfAborted()
    const headers = item.headers
    await store.mail.saveThread({
      accountId,
      externalId: item.threadId,
      now: startedAt,
      emails: [
        {
          externalId: item.messageId,
          // Subject and text stay out of the columns search reads, so recorded mail is never a search hit.
          subject: null,
          from: headers?.from === undefined ? null : { address: headers.from, name: headers.fromName ?? null },
          sentAt: null,
          receivedAt: Date.parse(item.receivedAt),
          bodyText: null,
          size: item.size ?? null,
          outgoing: headers?.from === key.account,
          mailboxes: [...inMailboxes(item), envelopeBox(rule.match)],
          ...flagsOf(item),
          mailRuleId: rule.id ?? null,
          metadata: {
            rule: { action: rule.action, match: { ...rule.match } },
            ...(headers?.subject ? { subject: headers.subject } : {}),
            ...(headers?.listId ? { listId: headers.listId } : {}),
            ...(headers?.replyTo ? { replyTo: headers.replyTo } : {}),
            ...(headers?.auth ? { auth: { ...headers.auth } } : {}),
          },
        },
      ],
    })
    envelopes++
    settled.add(item.messageId)
    await tagStored(item)
    await saveNow()
  }
  const fetchChunk = plan === undefined ? FETCH_CHUNK : (source.fetchBatch ?? FETCH_SLICE)
  for (let start = 0; start < pending.length; start += fetchChunk) {
    await stopIfAborted()
    const chunk = pending.slice(start, start + fetchChunk)
    if (plan !== undefined) {
      const stop = plan.budget.take()
      if (stop) {
        plan.stopped = stop
        full = true
        break
      }
    }
    let raws: (Uint8Array | Error)[]
    try {
      raws = await source.fetchRaw(chunk)
    } catch (error) {
      // What this run saved stays saved: the next one goes on from it.
      await saveNow(true)
      throw error
    }
    await stopIfAborted()
    // Every email of a chunk failing is the connection or the login, not the mail: stop instead of trying the rest.
    if (chunk.length > 1 && raws.every((raw) => raw instanceof Error)) {
      await saveNow(true)
      throw raws[0]
    }
    for (const [index, item] of chunk.entries()) {
      let mail: ParsedMail
      try {
        const raw = raws[index]
        if (raw === undefined || raw instanceof Error) throw raw ?? new Error("not read")
        mail = await parseMail(raw, maxBodyChars)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        unreadable.push({ message: item.messageId, reason })
        if (plan !== undefined) {
          plan.unreadable.set(item.messageId, reason)
          plan.failed.add(keyOf(item.folder ?? (folders[0] as string), item.uid))
        }
        continue
      }
      plan?.unreadable.delete(item.messageId)
      const header = mailHeadersOf(raws[index] as Uint8Array)
      const files = await readAttachments(
        mail,
        item.messageId,
        { loadEngine, maxAttachmentChars, at: startedAt },
        attachments,
      )
      await store.mail.saveThread({
        accountId,
        externalId: item.threadId,
        now: startedAt,
        emails: [
          {
            externalId: item.messageId,
            subject: mail.subject,
            from: mail.from === null ? null : addressOf(mail.from),
            to: mail.to.map(addressOf),
            cc: mail.cc.map(addressOf),
            bcc: mail.bcc.map(addressOf),
            sentAt: null,
            receivedAt: Date.parse(item.receivedAt),
            bodyText: mail.text || null,
            size: item.size ?? null,
            ...(Object.keys(header).length ? { headers: header } : {}),
            outgoing: mail.from === null ? null : mail.from.email === key.account,
            mailboxes: inMailboxes(item),
            ...flagsOf(item),
            ...(upgraded.has(item.messageId) ? { metadata: {} } : {}),
            mailRuleId: decide(rules, factsFor(item))?.id ?? null,
            attachments: files,
          },
        ],
      })
      saved++
      settled.add(item.messageId)
      await tagStored(item)
      const boxes = upgraded.get(item.messageId)
      if (boxes !== undefined)
        await store.mail.setMailboxes(accountId, boxes.map(envelopeBoxOf), new Map([[item.messageId, []]]), startedAt)
    }
    await saveNow()
  }
  await saveNow(true)
  if (snapshot && mboxStamp !== undefined && mboxPoint === undefined) {
    const point: MboxPoint = {
      ...mboxStamp,
      complete: !full && unreadable.length === 0,
      updatedAt: new Date(now()).toISOString(),
    }
    await store.sync.setSyncState(key, MBOX_RESUME, JSON.stringify(point))
  }

  // Read and starred change at the source after import; mail saved in this run already holds them.
  if (!snapshot)
    await store.mail.setFlags(
      accountId,
      new Map(
        [...labelsOf].flatMap(([id, { seen, flagged }]) =>
          seen === undefined && flagged === undefined
            ? []
            : [[id, { ...(seen === undefined ? {} : { read: seen }), ...(flagged === undefined ? {} : { flagged }) }]],
        ),
      ),
      startedAt,
    )

  const incomplete = plan !== undefined && (capped || plan.stopped !== null || plan.failed.size > 0)
  const complete = !full && !incomplete && unreadable.length === 0 && (plan?.unreadable.size ?? 0) === 0
  const bulk = new Map(
    listed.filter((item) => item.headers?.bulk).map((item) => [item.messageId, [bulkBox.externalId]]),
  )
  if (bulk.size) await store.mail.setMailboxes(accountId, [bulkBox], bulk, startedAt)
  if (!snapshot) await store.sync.setSyncState(key, "mail_folder_scope", scope)
  await stopIfAborted()
  const indexed = await index?.(store, key)
  const coverage = {
    folders,
    since: since.toISOString(),
    until: new Date(startedAt).toISOString(),
    state: complete ? ("window" as const) : ("partial" as const),
    identity: account.mode === "imap" ? "message-id-or-uidvalidity-folder-uid" : "gmail-message-id",
  }
  if (!snapshot) await store.sync.setSyncState(key, "mail_coverage", JSON.stringify(coverage))
  const tagging = tagger.outcome()
  await settleRuleTags(store, accountId, rules, tagging)
  return {
    account: key.account,
    since: since.toISOString(),
    listed: listed.length,
    saved,
    alreadyStored,
    skipped: ruledOut,
    envelopes,
    deleted,
    complete,
    ...(indexed === undefined ? {} : { indexed }),
    coverage,
    ...(attachments.length ? { attachments } : {}),
    ...(unreadable.length ? { unreadable } : {}),
    ...(skipped === undefined ? {} : { deletionsSkipped: skipped }),
    ...(searches.size > 0 ? { pass: resumed.size > 0 ? ("resumed" as const) : ("full" as const) } : {}),
    ...(tagging.reused.length ? { tagsReused: tagging.reused } : {}),
    ...(tagging.skipped.length ? { tagsSkipped: tagging.skipped } : {}),
  }
}

/** Failures a newer install mends: the reader was missing, not the file at fault, so reading again can succeed. */
export const RETRYABLE_ATTACHMENTS = ["engine-missing"]

/**
 * Reads again, by Gmail id, only the stored emails with an attachment a missing reader left unread: memo keeps no
 * attachment file, so the email comes from the source again. Nothing is listed, so no deletion is proved and no
 * resume point moves; the email keeps its stored mailboxes, flags and rule.
 */
const retryUnread = async ({
  store,
  source,
  account,
  since,
  max,
  maxBodyChars,
  maxAttachmentChars,
  now,
  loadEngine,
  index,
}: {
  store: MessageStore
  source: MailSource
  account: MailAccount
  since: Date
  max: number
  maxBodyChars: number
  maxAttachmentChars: number
  now: () => number
  loadEngine: LoadEngine
  index: MailSyncOptions["index"]
}): Promise<MailSyncResult> => {
  const startedAt = now()
  const key: AccountKey = { provider: "email", account: account.address.toLowerCase() }
  const find = source.find
  if (find === undefined)
    throw new CliError(
      "validation_error",
      "--retry-attachments reads mail again by its Gmail id; an mbox file or a plain IMAP account has none",
    )
  const accountId = await store.accounts.saveAccount(key, { name: account.address })
  const wanted = (await store.mail.emailRefs({ accountId, attachmentErrors: RETRYABLE_ATTACHMENTS })).map(
    ({ externalId }) => externalId,
  )
  const chosen = wanted.slice(0, max)
  const found = new Map<string, Listed>()
  for (const folder of await mailFolders(account, source)) {
    const left = chosen.filter((id) => !found.has(id))
    if (left.length === 0) break
    for (const item of await find(left, folder)) if (!found.has(item.messageId)) found.set(item.messageId, item)
  }
  const items = [...found.values()]
  const attachments: AttachmentLog = []
  const unreadable: NonNullable<MailSyncResult["unreadable"]> = []
  let emails = 0
  let extracted = 0
  let stillFailed = 0
  for (let start = 0; start < items.length; start += FETCH_CHUNK) {
    const chunk = items.slice(start, start + FETCH_CHUNK)
    const raws = await source.fetchRaw(chunk)
    for (const [index, item] of chunk.entries()) {
      const raw = raws[index]
      const stored = await store.mail.email(accountId, item.messageId)
      if (stored === null) continue
      let mail: ParsedMail
      try {
        if (raw === undefined || raw instanceof Error) throw raw ?? new Error("not read")
        mail = await parseMail(raw, maxBodyChars)
      } catch (error) {
        unreadable.push({ message: item.messageId, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      const before = new Map(stored.attachments.map(({ position, extractionError }) => [position, extractionError]))
      const files = await readAttachments(
        mail,
        item.messageId,
        { loadEngine, maxAttachmentChars, at: startedAt },
        attachments,
      )
      for (const file of files)
        if (RETRYABLE_ATTACHMENTS.includes(before.get(file.position) ?? ""))
          if (file.extraction === "text") extracted++
          else stillFailed++
      const header = mailHeadersOf(raw as Uint8Array)
      await store.mail.saveThread({
        accountId,
        externalId: item.threadId,
        now: startedAt,
        emails: [
          {
            externalId: item.messageId,
            subject: mail.subject,
            from: mail.from === null ? null : addressOf(mail.from),
            to: mail.to.map(addressOf),
            cc: mail.cc.map(addressOf),
            bcc: mail.bcc.map(addressOf),
            sentAt: null,
            receivedAt: Date.parse(item.receivedAt),
            bodyText: mail.text || null,
            size: item.size ?? stored.size,
            ...(Object.keys(header).length ? { headers: header } : {}),
            outgoing: mail.from === null ? null : mail.from.email === key.account,
            mailboxes: stored.mailboxes.map(({ externalId, name, kind }) => ({ externalId, name, kind })),
            ...(stored.read === null ? {} : { read: stored.read }),
            ...(stored.flagged === null ? {} : { flagged: stored.flagged }),
            metadata: stored.metadata,
            mailRuleId: stored.mailRuleId,
            attachments: files,
          },
        ],
      })
      emails++
    }
  }
  const indexed = await index?.(store, key)
  return {
    account: key.account,
    since: since.toISOString(),
    listed: items.length,
    saved: 0,
    alreadyStored: 0,
    skipped: 0,
    envelopes: 0,
    deleted: 0,
    complete: wanted.length <= max && unreadable.length === 0,
    ...(indexed === undefined ? {} : { indexed }),
    retried: { emails, extracted, stillFailed, missing: chosen.length - items.length },
    ...(attachments.length ? { attachments } : {}),
    ...(unreadable.length ? { unreadable } : {}),
  }
}
