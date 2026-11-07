import { CliError } from "@wirecat/cli-base"
import { type BudgetStop, type RunBudget, runBudget } from "../background/budget.js"
import { progressLine, progressOf } from "../background/checkpoints.js"
import { CRM_KINDS, type CrmItem, type CrmKind, isItemKind } from "../domain/crm.js"
import { DEAL_KINDS, type DealKind } from "../domain/deals.js"
import { isCliFailure } from "../errors/failures.js"
import type { CrmRelationIssue, CrmSaved, CrmSkipped } from "../store/sqlite/crm.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import type { CrmPage, CrmSource } from "./source.js"

const DAY = 86_400_000
/** A row the CRM changed this close to the id pass's start may be newer than the list, by the two clocks' skew. */
const CLOCK_MARGIN = 60 * 60_000
/** An id pass that would mark more than this share of a kind deleted is held: a CRM that lost its rights lists none. */
const MOST_UNLISTED = 0.5
/** Below this many stored rows a pass may empty a kind: a small CRM really may lose half its deals. */
const GUARDED_FROM = 10

/** A round of changes that stopped before its last page: the next run goes on from its page with the same cursor. */
interface PendingRound {
  from: string | null
  page: string | null
  reset: boolean
}

/** A list of every id that stopped before its end: the ids it has seen, and its next page. */
interface PendingPass {
  page: string | null
  startedAt: number
  seen: string[]
}

/** What the engine keeps per kind in `store.sync` under `crm:<kind>`. */
export interface CrmCursor {
  v: 1
  /** The CRM's cursor after the last finished round; `null` before the first. */
  token: string | null
  round: PendingRound | null
  /** Rows saved by the round in progress, or by the last one. */
  done: number
  updatedAt: number | null
  pass: PendingPass | null
  /** When the last complete id pass started; 0 before the first. */
  passAt: number
}

const isToken = (value: unknown): value is string | null => value === null || typeof value === "string"

export const parseCrmCursor = (value: string | null | undefined): CrmCursor | null => {
  if (value == null) return null
  try {
    const cursor = JSON.parse(value) as Partial<CrmCursor> | null
    if (cursor?.v !== 1 || !isToken(cursor.token) || typeof cursor.done !== "number") return null
    const round = cursor.round
    const pass = cursor.pass
    if (round != null && (!isToken(round.from) || !isToken(round.page) || typeof round.reset !== "boolean")) return null
    if (
      pass != null &&
      (!isToken(pass.page) ||
        typeof pass.startedAt !== "number" ||
        !Array.isArray(pass.seen) ||
        pass.seen.some((id) => typeof id !== "string"))
    )
      return null
    return {
      v: 1,
      token: cursor.token,
      round: round ?? null,
      done: cursor.done,
      updatedAt: typeof cursor.updatedAt === "number" ? cursor.updatedAt : null,
      pass: pass ?? null,
      passAt: typeof cursor.passAt === "number" ? cursor.passAt : 0,
    }
  } catch {
    return null
  }
}

export const cursorName = (kind: CrmKind): string => `crm:${kind}`

export interface CrmSyncOptions {
  now?: number
  /** List everything again and every id, dropping a round in progress: `sync --rescan`. */
  rescan?: boolean
  /** Asked before every request to the CRM; without one the run goes until every kind is done. */
  budget?: RunBudget
  /** Checked after every request: a cancelled run stops and keeps what it saved. */
  signal?: AbortSignal
  /** How long a complete id pass holds before the next one; a day when absent. */
  passEvery?: number
}

/** Something a run could not do that the owner should know: an item not kept, or a deletion held back. */
export interface CrmSyncIssue {
  /** `user`: the account's users and departments. */
  kind: CrmKind | "user"
  reason: CrmSkipped["reason"] | CrmRelationIssue["reason"] | "crm.unlisted-held" | "crm.not-reported"
  message: string
  externalId?: string
}

export interface CrmSyncResult {
  kind: CrmKind
  /** `full`: everything was listed; `changes`: only what changed since the cursor. */
  round: "full" | "changes"
  /** The cursor was dead, so the round became a full one. */
  reset: boolean
  state: "partial" | "complete"
  saved: number
  /** Rows the CRM said it deleted, now marked deleted. */
  removed: number
  /** Rows a complete id pass did not list, now marked deleted. */
  unlisted: number
  /** `complete`: a full list of ids arrived; `partial`: it stopped and goes on next run; `held`: it would mark too many. */
  pass?: "complete" | "partial" | "held"
  /** Set when the kind failed; its cursor stays at its last saved page. */
  error?: string
}

export interface CrmSyncReport {
  provider: string
  account: string
  /** Pipelines read this run, both kinds. */
  pipelines: number
  /** Users read this run; absent when the CRM cannot list them. */
  users?: number
  /** Relationships left out because the owner removed or rejected that very one, role included. */
  skippedOwnerRejected: number
  synced: CrmSyncResult[]
  issues: CrmSyncIssue[]
  /** Every kind finished its round and none failed. */
  complete: boolean
  state: "partial" | "complete"
  stopped?: BudgetStop
  progress: {
    /** Requests made to the CRM. */
    requests: number
    saved: number
    /** Pages saved: 0 means this run moved nothing on. */
    steps: number
  }
  hint?: string
}

const CONTINUE = "run sync again to continue"

const fresh = (): CrmCursor => ({ v: 1, token: null, round: null, done: 0, updatedAt: null, pass: null, passAt: 0 })

interface Run {
  source: CrmSource
  store: MessageStore
  account: AccountKey
  now: number
  budget: RunBudget
  signal: AbortSignal | undefined
  report: CrmSyncReport
  /** Pipelines are read again at most once a run, for an item whose stage arrived after they were read. */
  pipelinesReread: Set<DealKind>
  moved: () => void
}

const readPipelines = async (run: Run, kind: DealKind): Promise<BudgetStop | null> => {
  const why = run.budget.take()
  if (why) return why
  const pipelines = await run.source.pipelines(kind)
  const { saved, skipped } = await run.store.crm.savePipelines(run.account, kind, pipelines)
  run.report.pipelines += saved
  for (const one of skipped) run.report.issues.push({ kind, ...one })
  return null
}

const noted = (run: Run, kind: CrmSyncIssue["kind"], saved: CrmSaved) => {
  for (const { externalId, ...one } of saved.issues ?? [])
    run.report.issues.push({ kind, ...one, ...(externalId ? { externalId } : {}) })
  run.report.skippedOwnerRejected += saved.skippedOwnerRejected ?? 0
}

/**
 * The account's users and departments, listed whole each run: before deals, so a deal's owner is a person. A CRM that
 * cannot list departments says so, and no reporting line is touched.
 */
const readUsers = async (run: Run): Promise<BudgetStop | null> => {
  const { source } = run
  if (!source.users) return null
  const why = run.budget.take()
  if (why) return why
  const gap = (what: string, error?: unknown) =>
    run.report.issues.push({
      kind: "user",
      reason: "crm.not-reported",
      // The adapter's own text may carry a request; only its failure code is copied.
      message: `${source.provider} did not list ${what}${error instanceof CliError ? ` (${error.code})` : ""}`,
    })
  let users: Awaited<ReturnType<NonNullable<CrmSource["users"]>>>
  try {
    users = await source.users()
  } catch (error) {
    if (run.signal?.aborted) throw error
    gap("its users, so nothing stored about them changed", error)
    return null
  }
  let departments: Awaited<ReturnType<NonNullable<CrmSource["departments"]>>> | undefined
  if (!source.departments) gap("departments: who reports to whom is unknown")
  else {
    const stop = run.budget.take()
    if (stop) return stop
    try {
      departments = await source.departments()
    } catch (error) {
      if (run.signal?.aborted) throw error
      gap("departments: who reports to whom is unknown", error)
    }
  }
  noted(run, "user", await run.store.crm.saveUsers(run.account, users, departments))
  run.report.users = users.length
  return null
}

const readFields = async (run: Run, kind: CrmKind): Promise<BudgetStop | null> => {
  const why = run.budget.take()
  if (why) return why
  const fields = await (run.source.fields as NonNullable<CrmSource["fields"]>).call(run.source, kind)
  const { skipped } = await run.store.crm.saveFields(run.account, kind, fields)
  for (const one of skipped) run.report.issues.push({ kind, ...one })
  return null
}

/** One page saved; an item whose stage is unknown gets one more chance after the kind's pipelines are read again. */
const savePage = async (
  run: Run,
  kind: CrmKind,
  page: CrmPage<unknown>,
): Promise<{ saved: number; stop: BudgetStop | null }> => {
  const { store, account } = run
  if (!isItemKind(kind)) {
    const saved =
      kind === "person"
        ? await store.crm.savePeople(account, page.items as Parameters<typeof store.crm.savePeople>[1])
        : await store.crm.saveOrganizations(account, page.items as Parameters<typeof store.crm.saveOrganizations>[1])
    noted(run, kind, saved)
    return { saved: saved.saved, stop: null }
  }
  const items = page.items as CrmItem[]
  const first = await store.crm.saveItems(account, kind, items)
  noted(run, kind, first)
  let { saved, skipped } = first
  let stop: BudgetStop | null = null
  if (skipped.some(({ reason }) => reason === "crm.stage-unknown") && !run.pipelinesReread.has(kind)) {
    run.pipelinesReread.add(kind)
    stop = await readPipelines(run, kind)
    if (!stop) {
      const again = new Set(
        skipped.filter(({ reason }) => reason === "crm.stage-unknown").map(({ externalId }) => externalId),
      )
      const retried = await store.crm.saveItems(
        account,
        kind,
        items.filter(({ externalId }) => again.has(externalId)),
      )
      noted(run, kind, retried)
      saved += retried.saved
      skipped = [...skipped.filter(({ reason }) => reason !== "crm.stage-unknown"), ...retried.skipped]
    }
  }
  // An item not kept is named, and the round goes on: one bad row must not stop the CRM's copy for good.
  for (const one of skipped) run.report.issues.push({ kind, ...one })
  return { saved, stop }
}

const syncKind = async (run: Run, kind: CrmKind, options: CrmSyncOptions, result: CrmSyncResult) => {
  const { source, store, account, now, budget, signal } = run
  const name = cursorName(kind)
  let cursor = parseCrmCursor((await store.sync.syncState(account, name))?.value) ?? fresh()
  if (options.rescan)
    cursor = { ...cursor, round: { from: null, page: null, reset: false }, done: 0, pass: null, passAt: 0 }
  let round: PendingRound = cursor.round ?? { from: cursor.token, page: null, reset: false }
  if (cursor.round === null) cursor = { ...cursor, done: 0 }
  let listed = false
  const show = () => Object.assign(result, { round: round.from === null ? "full" : "changes", reset: round.reset })
  show()
  const save = async (patch: Partial<CrmCursor> = {}) => {
    cursor = { ...cursor, round: listed ? null : round, updatedAt: now, ...patch }
    await store.sync.setSyncState(account, name, JSON.stringify(cursor))
  }
  let restarted = false
  const pages = new Set<string>()
  for (;;) {
    const why = budget.take()
    if (why) return why
    const page = await source.changes(kind, round.from, round.page ?? undefined)
    if (signal?.aborted) return "cancelled" as const
    if ("reset" in page) {
      if (round.page !== null && !restarted) {
        restarted = true
        round = { ...round, page: null }
      } else if (round.from === null)
        throw new CliError("invalid_response", `${source.provider} refused a full list as a dead cursor`)
      else round = { from: null, page: null, reset: true }
      cursor = { ...cursor, done: 0 }
      show()
      await save()
      continue
    }
    const { saved, stop } = await savePage(run, kind, page)
    result.saved += saved
    cursor = { ...cursor, done: cursor.done + saved }
    if (page.removed?.length) result.removed += await store.crm.remove(account, kind, page.removed)
    run.moved()
    if (page.nextPage === undefined) {
      listed = true
      await save({ token: page.cursor ?? null })
      break
    }
    if (pages.has(page.nextPage))
      throw new CliError("invalid_response", `${source.provider} returned the same page twice`)
    pages.add(page.nextPage)
    round = { ...round, page: page.nextPage }
    await save()
    if (stop) return stop
  }
  const passes = source.ids && !source.traits.removedInChanges && kind !== "person"
  const due = cursor.pass !== null || now - cursor.passAt >= (options.passEvery ?? DAY)
  if (passes && due) {
    const ids = source.ids as NonNullable<CrmSource["ids"]>
    let pass = cursor.pass ?? { page: null, startedAt: now, seen: [] }
    for (;;) {
      const why = budget.take()
      if (why) {
        result.pass = "partial"
        await save({ pass })
        return why
      }
      const page = await ids.call(source, kind, pass.page ?? undefined)
      if (signal?.aborted) return "cancelled" as const
      pass = { ...pass, seen: [...pass.seen, ...page.ids], page: page.nextPage ?? null }
      run.moved()
      if (page.nextPage === undefined) break
      await save({ pass })
    }
    const before = pass.startedAt - CLOCK_MARGIN
    const stored = await store.crm.count(account, kind)
    const unlisted = await store.crm.removeUnlisted(account, kind, pass.seen, before, { dryRun: true })
    if (!options.rescan && stored >= GUARDED_FROM && unlisted > stored * MOST_UNLISTED) {
      result.pass = "held"
      run.report.issues.push({
        kind,
        reason: "crm.unlisted-held",
        message:
          `${source.provider} listed ${pass.seen.length} ${kind} ids, so ${unlisted} of the ${stored} stored would be ` +
          "marked deleted; nothing was — check the sign-in's rights, then run sync --rescan to let it through",
      })
    } else {
      result.unlisted = await store.crm.removeUnlisted(account, kind, pass.seen, before)
      result.pass = "complete"
    }
    await save({ pass: null, passAt: pass.startedAt })
  }
  result.state = "complete"
  return null
}

/**
 * Brings one CRM account's copy up to date: both kinds' pipelines and each kind's fields, then companies, contacts,
 * the account's users and departments, deals and leads, each from its cursor or listed in full, a page at a time,
 * each page saved with the round's place in the cursor, so a run the budget stops, or one that fails, goes on from
 * there. Relationships held back for an end not stored yet are written at the end of the run. Deletions come from `changes()`, or
 * from a list of every id that marks only after its last page arrived, and never more than half of a kind without
 * `--rescan`.
 */
export const syncCrm = async (
  source: CrmSource,
  store: MessageStore,
  account: AccountKey,
  options: CrmSyncOptions = {},
): Promise<CrmSyncReport> => {
  const now = options.now ?? Date.now()
  const budget = options.budget ?? runBudget()
  const report: CrmSyncReport = {
    provider: source.provider,
    account: account.account,
    pipelines: 0,
    skippedOwnerRejected: 0,
    synced: [],
    issues: [],
    complete: true,
    state: "complete",
    progress: { requests: 0, saved: 0, steps: 0 },
  }
  let steps = 0
  const run: Run = {
    source,
    store,
    account,
    now,
    budget,
    signal: options.signal,
    report,
    pipelinesReread: new Set(),
    moved: () => {
      steps += 1
    },
  }
  const kinds = CRM_KINDS.filter((kind) => source.traits.kinds.includes(kind))
  let stopped: BudgetStop | null = null
  for (const kind of DEAL_KINDS)
    if (!stopped && kinds.includes(kind)) {
      stopped = await readPipelines(run, kind)
      if (options.signal?.aborted) stopped = "cancelled"
    }
  if (run.source.fields)
    for (const kind of kinds)
      if (!stopped) {
        stopped = await readFields(run, kind)
        if (options.signal?.aborted) stopped = "cancelled"
      }
  let usersRead = false
  for (const kind of kinds) {
    if (!usersRead && isItemKind(kind)) {
      usersRead = true
      if (!stopped) stopped = await readUsers(run)
    }
    const result: CrmSyncResult = {
      kind,
      round: "changes",
      reset: false,
      state: "partial",
      saved: 0,
      removed: 0,
      unlisted: 0,
    }
    report.synced.push(result)
    if (stopped) continue
    try {
      stopped = await syncKind(run, kind, options, result)
    } catch (error) {
      if (options.signal?.aborted) {
        stopped = "cancelled"
        continue
      }
      // An adapter's own failure says what went wrong; anything else may carry a request URL with a secret in it.
      result.error = isCliFailure(error) ? error.message : `the ${kind} copy could not be synced`
    }
  }
  // A relationship held back for an end a later page or kind brought is written now; it costs no request.
  await store.crm.retryPending(account)
  report.progress = {
    requests: budget.used,
    saved: report.synced.reduce((sum, one) => sum + one.saved, 0),
    steps,
  }
  report.complete = report.synced.every((one) => one.state === "complete" && one.error === undefined)
  report.state = report.complete && stopped === null ? "complete" : "partial"
  if (stopped) report.stopped = stopped
  if (report.state === "partial") {
    report.complete = false
    report.hint = CONTINUE
  }
  return report
}

/** Each kind's sync in the WC-LIFE-14 shape: `cursor_age_ms` growing on a `partial` one means nothing moves it. */
export const crmStatus = async (
  store: MessageStore,
  account: AccountKey,
  { profile, now, kinds = CRM_KINDS }: { profile: string; now: number; kinds?: readonly CrmKind[] },
) => {
  const items = []
  for (const kind of kinds) {
    const cursor = parseCrmCursor((await store.sync.syncState(account, cursorName(kind)))?.value)
    const progress = progressOf({
      job: `crm ${kind}`,
      profile,
      done: cursor?.done ?? 0,
      complete: cursor !== null && cursor.round === null && cursor.pass === null,
      ...(cursor?.updatedAt == null ? {} : { updatedAt: new Date(cursor.updatedAt).toISOString() }),
      now: new Date(now),
    })
    items.push({
      kind,
      round: cursor?.round ? (cursor.round.from === null ? "full" : "changes") : null,
      id_pass: cursor?.pass ? "partial" : cursor?.passAt ? new Date(cursor.passAt).toISOString() : null,
      stored: await store.crm.count(account, kind),
      ...progress,
      line: progressLine(progress),
    })
  }
  return { items, page: 1, limit: Math.max(1, items.length), hasMore: false }
}
