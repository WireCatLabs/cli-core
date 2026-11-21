import { CliError, isCliError } from "@wirecat/cli-base"
import { type BudgetStop, type RunBudget, runBudget } from "../background/budget.js"
import { CONTENT_KINDS, type ContentChannel, type ContentKind } from "../domain/content.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { type ContentCallContext, type ContentGap, type ContentSource, GET_UNSUPPORTED } from "./source.js"

const DAY = 86_400_000
/** An id pass that would mark more than this share of a kind deleted is held: a source that lost rights lists none. */
const MOST_UNLISTED = 0.5
const GUARDED_FROM = 10
/** Scheduled posts past their time read one by one per run; more wait for the next. */
const MOST_DUE = 50

interface Mode {
  drop: boolean
  full: boolean
}

interface ContentCursor {
  v: 1
  token: string | null
  /**
   * `gapped`: a read of this round was refused, so its end keeps the cursor it started from. `lacks`: the rights the
   * sign-in lacked in this round (lasting gaps), which its end keeps beside the cursor.
   */
  round: { from: string | null; page: string | null; gapped?: true; lacks?: string[] } | null
  passAt: number
  /** The rights the sign-in lacked when the cursor was taken: one it has now shows rows older than the cursor. */
  lacks?: string[]
}

interface ContentPass {
  v: 1
  started: number
  page: string | null
  ids: string[]
  /** A page of this pass was refused, in this run or an earlier one: its absences prove nothing. */
  gapped?: true
}

/** The sign-in may not read it, which proves nothing about the row; WordPress also refuses with 400 and 403 inside. */
const refusedRead = (error: unknown): error is CliError =>
  isCliError(error) && (error.code === "permission_error" || error.details.inner_status === 403)

const lackOf = (gap: ContentGap) => gap.scope ?? gap.message
/** A refusal of this kind in this run, which proves nothing about the rows it left out; a right the role lacks does. */
const refusedIn = (run: Run, kind: ContentKind) => run.report.gaps.some((gap) => gap.kind === kind && !gap.lasting)
const lackedIn = (run: Run, kind: ContentKind) =>
  run.report.gaps.flatMap((gap) => (gap.kind === kind && gap.lasting ? [lackOf(gap)] : []))

const fresh = (): ContentCursor => ({ v: 1, token: null, round: null, passAt: 0 })

const parsed = <T extends { v: number }>(value: string | null | undefined): T | null => {
  try {
    const found = JSON.parse(value ?? "null") as T | null
    return found?.v === 1 ? found : null
  } catch {
    return null
  }
}

export const contentCursorName = (kind: ContentKind): string => `content:${kind}`
const passName = (kind: ContentKind) => `content:${kind}:pass`
const GAPS = "content:gaps"
const RESUME = "content:resume"
const MOVED = "content:moved"

export interface ContentSyncOptions {
  now?: number
  /** List everything again and every id, dropping a round in progress: `sync --rescan`. */
  rescan?: boolean
  budget?: RunBudget
  signal?: AbortSignal
  /** How long a complete id pass holds before the next one; a day when absent. */
  passEvery?: number
}

export interface ContentSyncResult {
  kind: ContentKind
  round: "full" | "changes"
  reset: boolean
  state: "partial" | "complete"
  saved: number
  /** Rows a complete id pass did not list, or a read answered gone, now marked deleted. */
  unlisted: number
  /** `held`: it would mark too much deleted, the sign-in read only part, or the site moved; nothing was marked. */
  pass?: "complete" | "partial" | "held"
  held?: string
  error?: string
}

export interface ContentSyncReport {
  provider: string
  account: string
  channels: number
  /** The channel's address changed since the last sync: no deletion is marked until the owner rescans. */
  moved?: { channel: string; from: string; to: string }[]
  synced: ContentSyncResult[]
  /** Scheduled posts past their time, read again. */
  due: number
  /** Readings of posts' numbers saved. */
  metrics: number
  gaps: ContentGap[]
  complete: boolean
  state: "partial" | "complete"
  stopped?: BudgetStop
  progress: { requests: number; saved: number; steps: number }
}

class BudgetSpent extends Error {
  constructor(readonly why: BudgetStop) {
    super(`the run's budget is spent: ${why}`)
  }
}

interface Run {
  source: ContentSource
  store: MessageStore
  account: AccountKey
  now: number
  budget: RunBudget
  signal?: AbortSignal
  context: ContentCallContext
  report: ContentSyncReport
}

const syncChanges = async (run: Run, kind: ContentKind, result: ContentSyncResult, mode: Mode) => {
  const { source, store, account, budget } = run
  const name = contentCursorName(kind)
  let cursor = parsed<ContentCursor>((await store.sync.syncState(account, name))?.value) ?? fresh()
  let round: NonNullable<ContentCursor["round"]> = mode.drop
    ? { from: null, page: null }
    : (cursor.round ?? { from: mode.full ? null : cursor.token, page: null })
  const noted = () => {
    if (refusedIn(run, kind)) round = { ...round, gapped: true }
    const lacks = [...new Set([...(round.lacks ?? []), ...lackedIn(run, kind)])].sort()
    if (lacks.length) round = { ...round, lacks }
  }
  const save = (patch: Partial<ContentCursor>) => {
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
    noted()
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
      result.saved += await store.content.save(account, kind, page.items, run.now)
      run.report.progress.saved += page.items.length
    }
    run.report.progress.steps += 1
    if (!page.hasMore) {
      const lacks = round.lacks ?? []
      // A right gained shows rows changed before the cursor, which a read of changes never reaches: list them all.
      if (round.from !== null && (cursor.lacks ?? []).some((one) => !lacks.includes(one))) {
        result.reset = true
        round = { from: null, page: null }
        pages.clear()
        continue
      }
      // Changes made while a read was refused would be past a new cursor: the next run reads from the old one again.
      await save({
        token: round.gapped ? round.from : (page.cursor ?? null),
        round: null,
        lacks: lacks.length ? lacks : undefined,
      })
      return null
    }
    if (page.nextCursor === undefined)
      throw new CliError("invalid_response", `${source.provider} said there are more ${kind}s but gave no cursor`)
    if (pages.has(page.nextCursor))
      throw new CliError("invalid_response", `${source.provider} gave the same page of ${kind}s twice`)
    pages.add(page.nextCursor)
    round = { ...round, page: page.nextCursor }
    await save({ round })
  }
}

/**
 * Lists every id of the kind and marks deleted each stored row the list lacks. Absence alone is not a deletion: a
 * pass is held when the list is empty, when it would mark most of the kind, when the sign-in could not read all of it,
 * or when the site's address changed. Only a complete list of a site that is still the same one marks anything.
 */
const passIds = async (run: Run, kind: ContentKind, result: ContentSyncResult, mode: Mode) => {
  const { source, store, account, budget } = run
  const name = passName(kind)
  const pending = mode.drop ? null : parsed<ContentPass>((await store.sync.syncState(account, name))?.value)
  let pass = pending ?? { v: 1, started: run.now, page: null, ids: [] }
  for (;;) {
    const why = budget.take()
    if (why) {
      await store.sync.setSyncState(account, name, JSON.stringify(pass))
      result.pass = "partial"
      return why
    }
    run.report.progress.requests += 1
    const page = await source.ids(kind, pass.page ?? undefined, run.context)
    if (run.signal?.aborted) {
      await store.sync.setSyncState(account, name, JSON.stringify(pass))
      result.pass = "partial"
      return "cancelled" as const
    }
    pass = { ...pass, ids: [...pass.ids, ...page.items] }
    if (refusedIn(run, kind)) pass = { ...pass, gapped: true }
    if (page.hasMore) {
      if (page.nextCursor === undefined || page.nextCursor === pass.page)
        throw new CliError("invalid_response", `${source.provider} gave no new page of ${kind} ids`)
      pass = { ...pass, page: page.nextCursor }
      await store.sync.setSyncState(account, name, JSON.stringify(pass))
      continue
    }
    const stored = await store.content.count(account, kind)
    const missing = await store.content.unlisted(account, kind, pass.ids, pass.started)
    const unlisted = missing.length
    // A role that sees only part lists less, the same each run: each row its list lacks is read once more below.
    const unread = pass.gapped === true || refusedIn(run, kind)
    const moved = (run.report.moved?.length ?? 0) > 0
    const emptied = pass.ids.length === 0 && unlisted > 0
    const many = emptied || (stored >= GUARDED_FROM && unlisted > stored * MOST_UNLISTED)
    if (unlisted > 0 && (unread || (moved && !mode.full) || (many && !mode.full))) {
      result.pass = "held"
      result.held = unread
        ? `${source.provider} could not read all ${kind}s, so the ${unlisted} it did not list stay; nothing was ` +
          "marked deleted. Check the sign-in's rights, then run sync again"
        : moved
          ? `the site's address changed since the last sync, so the ${unlisted} ${kind}s it did not list stay; ` +
            "nothing was marked deleted. If the site moved, run sync --rescan"
          : `${source.provider} listed ${pass.ids.length} ${kind} ids, so ${unlisted} of the ${stored} stored ` +
            "would be marked deleted; nothing was. Check the sign-in's rights, then run sync --rescan to let it through"
    } else {
      const why = await confirmGone(run, kind, missing, result)
      if (why) {
        await store.sync.setSyncState(account, name, JSON.stringify(pass))
        result.pass = "partial"
        return why
      }
      result.pass = "complete"
    }
    await store.sync.setSyncState(account, name, "null")
    const cursor =
      parsed<ContentCursor>((await store.sync.syncState(account, contentCursorName(kind)))?.value) ?? fresh()
    await store.sync.setSyncState(account, contentCursorName(kind), JSON.stringify({ ...cursor, passAt: pass.started }))
    return null
  }
}

/**
 * A scheduled post whose time has passed may have gone out without a change the source reports: each is read again
 * until it is published. A read that answers no post proves it deleted.
 */
const readDue = async (run: Run, result: ContentSyncResult) => {
  const { source, store, account, budget } = run
  for (const id of (await store.content.due(account, run.now)).slice(0, MOST_DUE)) {
    const why = budget.take()
    if (why) return why
    run.report.progress.requests += 1
    let post: Awaited<ReturnType<ContentSource["get"]>>
    try {
      post = await source.get("post", id, run.context)
    } catch (error) {
      if (isCliError(error) && error.details.reason === GET_UNSUPPORTED) return null
      // An author's scheduled page, stored by an editor's sign-in: a refusal holds it, and the other posts go on.
      if (!refusedRead(error)) throw error
      run.context.gap({
        kind: "post",
        message: `${source.provider} would not give this sign-in every post: ${error.message}`,
      })
      continue
    }
    if (post) result.saved += await store.content.save(account, "post", [post], run.now)
    else if (await store.content.markDeleted(account, "post", id, run.now)) result.unlisted += 1
    run.report.due += 1
  }
  return null
}

const readMetrics = async (run: Run) => {
  const { source, store, account, budget } = run
  if (!source.traits.metrics || !source.metrics) return null
  const posts = (await store.content.list(account, "post", { statuses: ["published"], limit: 500 })).items.map(
    (one) => one.record.externalId,
  )
  if (!posts.length) return null
  const why = budget.take()
  if (why) return why
  run.report.progress.requests += 1
  run.report.metrics += await store.content.saveMetrics(account, await source.metrics(posts, run.context))
  return null
}

/**
 * Each id a list lacked, read once more: a list paged by number skips a row when an earlier one goes, so only a read
 * that answers "gone" marks a row deleted. A row read back is saved; one the source cannot read alone is marked by its
 * absence from a complete list, as before.
 */
const confirmGone = async (run: Run, kind: ContentKind, missing: readonly string[], result: ContentSyncResult) => {
  const { source, store, account, budget } = run
  for (const id of missing) {
    const why = budget.take()
    if (why) return why
    run.report.progress.requests += 1
    let found: Awaited<ReturnType<ContentSource["get"]>>
    try {
      found = await source.get(kind, id, run.context)
    } catch (error) {
      // WordPress leaves others' drafts out of a contributor's list and refuses to read them, and a row of a status we
      // do not know reads as nothing: neither proves it gone.
      if (refusedRead(error) || (isCliError(error) && error.code === "invalid_response")) {
        run.context.gap({
          kind,
          message: `${source.provider} would not give this sign-in every ${kind}: ${error.message}`,
        })
        continue
      }
      if (!isCliError(error) || error.details.reason !== GET_UNSUPPORTED) throw error
      found = null
    }
    if (found) result.saved += await store.content.save(account, kind, [found], run.now)
    else if (await store.content.markDeleted(account, kind, id, run.now)) result.unlisted += 1
  }
  return null
}

/**
 * Channels first: a site whose address changed holds every deletion until `sync --rescan`, whichever run comes next. A
 * plain run would otherwise take the new address as the known one and mark the old site's posts deleted.
 */
const readChannels = async (run: Run, rescan: boolean) => {
  const { source, store, account } = run
  const before = new Map((await store.content.channels(account)).map((one) => [one.externalId, one]))
  run.report.progress.requests += 1
  const channels: ContentChannel[] = await source.channels(run.context)
  const moved = channels.flatMap((one) => {
    const was = before.get(one.externalId)?.url
    return was && one.url && was !== one.url ? [{ channel: one.externalId, from: was, to: one.url }] : []
  })
  type Moved = { v: 1; moved: typeof moved }
  const held = rescan ? [] : (parsed<Moved>((await store.sync.syncState(account, MOVED))?.value)?.moved ?? [])
  const all = [...held, ...moved]
  if (all.length) run.report.moved = all
  const kept: Moved = { v: 1, moved: all }
  await store.sync.setSyncState(account, MOVED, rescan || !all.length ? "null" : JSON.stringify(kept))
  run.report.channels = await store.content.saveChannels(account, channels, run.now)
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
 * Brings one content account's copy up to date: its channels, each kind's changes since its cursor, the scheduled
 * posts whose time has passed, once a day a pass over every id that marks deleted what the source no longer has, and a
 * reading of the published posts' numbers. A run that hits its budget stops where it is, and the next goes on.
 */
export const syncContent = async (
  source: ContentSource,
  store: MessageStore,
  account: AccountKey,
  options: ContentSyncOptions = {},
): Promise<ContentSyncReport> => {
  const now = options.now ?? Date.now()
  const budget = options.budget ?? runBudget()
  const passEvery = options.passEvery ?? DAY
  const report: ContentSyncReport = {
    provider: source.provider,
    account: account.account,
    channels: 0,
    synced: [],
    due: 0,
    metrics: 0,
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
        // A refusal with the same words as a right the role lacks still holds the cursor and the pass.
        const key = `${gap.kind} ${gap.message}${gap.lasting ? " lasting" : ""}`
        if (said.has(key)) return
        said.add(key)
        report.gaps.push(gap)
      },
    },
  }
  const fail = (why: string) => {
    report.complete = false
    report.state = "partial"
    return why
  }
  const stop = (why: BudgetStop) => {
    report.stopped = why
    fail(why)
  }
  if (budget.take()) {
    stop("requests")
    return report
  }
  const kinds = CONTENT_KINDS.filter((one) => source.traits.kinds.includes(one))
  const resumed = options.rescan
    ? null
    : parsed<{ v: 1; done: ContentKind[]; rescan?: true }>((await store.sync.syncState(account, RESUME))?.value)
  const done = new Set(resumed?.done ?? [])
  const mode: Mode = { drop: options.rescan === true, full: options.rescan === true || resumed?.rescan === true }
  await readChannels(run, mode.full)
  if (resumed)
    for (const gap of await contentGapsOf(store, account))
      if (done.has(gap.kind)) {
        said.add(`${gap.kind} ${gap.message}${gap.lasting ? " lasting" : ""}`)
        report.gaps.push(gap)
      }
  for (const kind of kinds.filter((one) => !done.has(one))) {
    const result: ContentSyncResult = { kind, round: "full", reset: false, state: "partial", saved: 0, unlisted: 0 }
    report.synced.push(result)
    let stopped: BudgetStop | null
    try {
      stopped = await stopping(() => syncChanges(run, kind, result, mode))
      if (!stopped && kind === "post") stopped = await stopping(() => readDue(run, result))
      const cursor = parsed<ContentCursor>((await store.sync.syncState(account, contentCursorName(kind)))?.value)
      const pending = parsed<ContentPass>((await store.sync.syncState(account, passName(kind)))?.value)
      const due = mode.full || pending !== null || now - (cursor?.passAt ?? 0) >= passEvery
      if (!stopped && due) stopped = await stopping(() => passIds(run, kind, result, mode))
    } catch (error) {
      result.error = fail(error instanceof Error ? error.message : String(error))
      continue
    }
    if (stopped) {
      stop(stopped)
      break
    }
    result.state = "complete"
    done.add(kind)
  }
  if (!report.stopped)
    try {
      const stopped = await stopping(() => readMetrics(run))
      if (stopped) stop(stopped)
    } catch (error) {
      // Numbers are a reading, not the copy: a source that refuses them leaves the posts synced.
      if (!isCliError(error)) throw error
      run.context.gap({ kind: "post", message: `${source.provider} gave no numbers: ${error.message}` })
    }
  await store.sync.setSyncState(
    account,
    RESUME,
    report.stopped ? JSON.stringify({ v: 1, done: [...done], ...(mode.full ? { rescan: true } : {}) }) : "null",
  )
  await store.sync.setSyncState(account, GAPS, JSON.stringify(report.gaps))
  return report
}

/** The gaps the account's last sync recorded; none before its first. */
export const contentGapsOf = async (store: MessageStore, account: AccountKey): Promise<ContentGap[]> => {
  try {
    const found = JSON.parse((await store.sync.syncState(account, GAPS))?.value ?? "[]") as unknown
    return Array.isArray(found) ? (found as ContentGap[]) : []
  } catch {
    return []
  }
}
