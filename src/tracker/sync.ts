import { CliError } from "@wirecat/cli-base"
import { type BudgetStop, type RunBudget, runBudget } from "../background/budget.js"
import { TRACKER_KINDS, type TrackerKind } from "../domain/tracker.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import type { TrackerCallContext, TrackerGap, TrackerSource } from "./source.js"

const DAY = 86_400_000

/** Where a kind stands between runs: the cursor of its last finished round, and the round or id pass in progress. */
interface TrackerCursor {
  v: 1
  /** The tracker's cursor after the last finished round; `null` before the first. */
  token: string | null
  /** A round that stopped before its last page: the next run goes on from `page` with the same `from`. */
  round: { from: string | null; page: string | null } | null
  /** When the last complete id pass started; 0 before the first. */
  passAt: number
}

/** An id pass in progress: the ids read so far, and the page to go on from. */
interface TrackerPass {
  v: 1
  started: number
  page: string | null
  ids: string[]
}

const fresh = (): TrackerCursor => ({ v: 1, token: null, round: null, passAt: 0 })

const parsed = <T extends { v: number }>(value: string | null | undefined): T | null => {
  try {
    const found = JSON.parse(value ?? "null") as T | null
    return found?.v === 1 ? found : null
  } catch {
    return null
  }
}

export const trackerCursorName = (kind: TrackerKind): string => `tracker:${kind}`
const passName = (kind: TrackerKind) => `tracker:${kind}:pass`
const GAPS = "tracker:gaps"
const RESUME = "tracker:resume"

export interface TrackerSyncOptions {
  now?: number
  /** List everything again and every id, dropping a round in progress: `sync --rescan`. */
  rescan?: boolean
  /** Asked before every request; without one the run goes until every kind is done. */
  budget?: RunBudget
  signal?: AbortSignal
  /** How long a complete id pass holds before the next one; a day when absent. */
  passEvery?: number
}

export interface TrackerSyncResult {
  kind: TrackerKind
  /** `full`: everything was listed; `changes`: only what changed since the cursor. */
  round: "full" | "changes"
  /** The cursor was dead, so the round became a full one. */
  reset: boolean
  state: "partial" | "complete"
  saved: number
  /** Rows a complete id pass did not list, now marked deleted. */
  unlisted: number
  /** `complete`: a full list of ids arrived; `partial`: it stopped and goes on next run. Absent: none was due. */
  pass?: "complete" | "partial"
  /** Set when the kind failed; its cursor stays at its last saved page. */
  error?: string
}

export interface TrackerSyncReport {
  provider: string
  account: string
  synced: TrackerSyncResult[]
  /** What the sign-in could not read, each once. */
  gaps: TrackerGap[]
  /** Every kind finished its round and none failed. */
  complete: boolean
  state: "partial" | "complete"
  stopped?: BudgetStop
  progress: { requests: number; saved: number; steps: number }
}

/** Thrown by `TrackerCallContext.spend` when the budget is spent; the engine turns it into a `partial` stop. */
class BudgetSpent extends Error {
  constructor(readonly why: BudgetStop) {
    super(`the run's budget is spent: ${why}`)
  }
}

interface Run {
  source: TrackerSource
  store: MessageStore
  account: AccountKey
  now: number
  budget: RunBudget
  signal?: AbortSignal
  context: TrackerCallContext
  report: TrackerSyncReport
}

/** Reads one kind's changes from where it stood, page by page, saving each page and the cursor after it. */
const syncChanges = async (run: Run, kind: TrackerKind, result: TrackerSyncResult, rescan: boolean) => {
  const { source, store, account, budget } = run
  const name = trackerCursorName(kind)
  let cursor = parsed<TrackerCursor>((await store.sync.syncState(account, name))?.value) ?? fresh()
  let round = rescan ? { from: null, page: null } : (cursor.round ?? { from: cursor.token, page: null })
  const save = (patch: Partial<TrackerCursor>) => {
    cursor = { ...cursor, ...patch }
    return store.sync.setSyncState(account, name, JSON.stringify(cursor))
  }
  const pages = new Set<string>()
  for (;;) {
    result.round = round.from === null ? "full" : "changes"
    const why = budget.take()
    if (why) {
      await save({ round })
      return why
    }
    run.report.progress.requests += 1
    const page = await source.changes(kind, round.from, round.page ?? undefined, run.context)
    if (run.signal?.aborted) {
      await save({ round })
      return "cancelled" as const
    }
    if ("reset" in page) {
      if (round.from === null)
        throw new CliError("invalid_response", `${source.provider} refused a full list of ${kind}s`)
      result.reset = true
      round = { from: null, page: null }
      pages.clear()
      continue
    }
    if (page.items.length) {
      result.saved += await store.tracker.save(account, kind, page.items, run.now)
      run.report.progress.saved += page.items.length
    }
    run.report.progress.steps += 1
    if (!page.hasMore || page.nextCursor === undefined) {
      await save({ token: page.cursor ?? null, round: null })
      return null
    }
    if (pages.has(page.nextCursor))
      throw new CliError("invalid_response", `${source.provider} gave the same page of ${kind}s twice`)
    pages.add(page.nextCursor)
    round = { ...round, page: page.nextCursor }
    await save({ round })
  }
}

/**
 * Lists every id of the kind and marks deleted each stored row the list lacks. Archived rows are listed, so only a row
 * the tracker deleted outright goes. A pass that stops keeps its ids and goes on next run.
 */
const passIds = async (run: Run, kind: TrackerKind, result: TrackerSyncResult, rescan: boolean) => {
  const { source, store, account, budget } = run
  const name = passName(kind)
  const pending = rescan ? null : parsed<TrackerPass>((await store.sync.syncState(account, name))?.value)
  let pass = pending ?? {
    v: 1,
    started: run.now,
    page: null,
    ids: [],
  }
  for (;;) {
    const why = budget.take()
    if (why) {
      await store.sync.setSyncState(account, name, JSON.stringify(pass))
      result.pass = "partial"
      return why
    }
    run.report.progress.requests += 1
    const page = await source.ids(kind, pass.page ?? undefined, run.context)
    pass = { ...pass, ids: [...pass.ids, ...page.items] }
    if (page.hasMore) {
      // A pass that ended early would mark every unread row deleted.
      if (page.nextCursor === undefined || page.nextCursor === pass.page)
        throw new CliError("invalid_response", `${source.provider} gave no new page of ${kind} ids`)
      pass = { ...pass, page: page.nextCursor }
      await store.sync.setSyncState(account, name, JSON.stringify(pass))
      continue
    }
    result.unlisted += await store.tracker.removeUnlisted(account, kind, pass.ids, pass.started, run.now)
    await store.sync.setSyncState(account, name, "null")
    const cursor =
      parsed<TrackerCursor>((await store.sync.syncState(account, trackerCursorName(kind)))?.value) ?? fresh()
    await store.sync.setSyncState(account, trackerCursorName(kind), JSON.stringify({ ...cursor, passAt: pass.started }))
    result.pass = "complete"
    return null
  }
}

const stopping = async (step: () => Promise<BudgetStop | null>): Promise<BudgetStop | null> => {
  try {
    return await step()
  } catch (error) {
    if (error instanceof BudgetSpent) return error.why
    throw error
  }
}

/**
 * Brings one tracker account's copy up to date: each kind's changes since its cursor, then, once a day, a pass over
 * every id that marks deleted what the tracker no longer has. A run that hits its budget stops where it is, saved,
 * and the next one goes on from there. A kind that fails is named and the others still sync.
 */
export const syncTracker = async (
  source: TrackerSource,
  store: MessageStore,
  account: AccountKey,
  options: TrackerSyncOptions = {},
): Promise<TrackerSyncReport> => {
  const now = options.now ?? Date.now()
  const budget = options.budget ?? runBudget()
  const passEvery = options.passEvery ?? DAY
  const report: TrackerSyncReport = {
    provider: source.provider,
    account: account.account,
    synced: [],
    gaps: [],
    complete: true,
    state: "complete",
    progress: { requests: 0, saved: 0, steps: 0 },
  }
  const said = new Set<string>()
  const run: Run = {
    source,
    store,
    account,
    now,
    budget,
    ...(options.signal ? { signal: options.signal } : {}),
    report,
    context: {
      spend: () => {
        const why = budget.take()
        if (why) throw new BudgetSpent(why)
        report.progress.requests += 1
      },
      gap: (gap) => {
        const key = `${gap.kind} ${gap.message}`
        if (said.has(key)) return
        said.add(key)
        report.gaps.push(gap)
      },
    },
  }
  const kinds = TRACKER_KINDS.filter((one) => source.traits.kinds.includes(one))
  // A budget smaller than the kinds would spend itself re-reading the finished ones: a run that stopped leaves the kinds
  // it finished, and the next one goes on with the rest.
  const done = new Set(
    options.rescan
      ? []
      : (parsed<{ v: 1; done: TrackerKind[] }>((await store.sync.syncState(account, RESUME))?.value)?.done ?? []),
  )
  for (const kind of kinds.filter((one) => !done.has(one))) {
    const result: TrackerSyncResult = { kind, round: "full", reset: false, state: "partial", saved: 0, unlisted: 0 }
    report.synced.push(result)
    let stop: BudgetStop | null
    try {
      stop = await stopping(() => syncChanges(run, kind, result, options.rescan === true))
      const cursor = parsed<TrackerCursor>((await store.sync.syncState(account, trackerCursorName(kind)))?.value)
      const pending = parsed<TrackerPass>((await store.sync.syncState(account, passName(kind)))?.value)
      const due = options.rescan === true || pending !== null || now - (cursor?.passAt ?? 0) >= passEvery
      if (!stop && due) stop = await stopping(() => passIds(run, kind, result, options.rescan === true))
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
      report.complete = false
      report.state = "partial"
      continue
    }
    if (stop) {
      report.stopped = stop
      report.complete = false
      report.state = "partial"
      break
    }
    result.state = "complete"
    done.add(kind)
  }
  await store.sync.setSyncState(account, RESUME, report.stopped ? JSON.stringify({ v: 1, done: [...done] }) : "null")
  await store.sync.setSyncState(account, GAPS, JSON.stringify(report.gaps))
  return report
}

/** The gaps the account's last sync recorded; none before its first. */
export const trackerGapsOf = async (store: MessageStore, account: AccountKey): Promise<TrackerGap[]> => {
  try {
    const found = JSON.parse((await store.sync.syncState(account, GAPS))?.value ?? "[]") as unknown
    return Array.isArray(found) ? (found as TrackerGap[]) : []
  } catch {
    return []
  }
}
