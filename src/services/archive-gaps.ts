import { createHash, randomUUID } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { Id } from "../domain/models.js"
import { type AccountKey, historyStartKey, type Range } from "../store/store.js"
import { abortable, archiveService, FETCHING, type Fetched } from "./archive.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./message-resolution.js"
import { type CatchUpOptions, type CatchUpResult, catchUpSearch, validateCatchUp } from "./search-catchup.js"

export const GAP_BOUNDS = { maxGaps: 5, limit: 500, timeMs: 30_000 }
export interface GapPlan {
  version: 1
  scope: "interior"
  account: AccountKey
  chat: Id
  ordering: "id" | "time"
  held: Range[]
  gaps: Range[]
  unknown: { older: boolean; newer: true }
  fingerprint: string
  limits: { maxGaps: number; limit: number; timeMs: number; pageSize: number }
}
export interface RepairOptions {
  catchUp?: CatchUpOptions | false
  maxGaps?: number
  limit?: number
  timeMs?: number
  pageSize?: number
  pauseMs?: number
  fingerprint?: string
  signal?: AbortSignal
  note?: (line: string) => void
  onPage?: (progress: { fetched: number; chatId: string; oldest: number }) => void
}
export interface GapRepair {
  version: 1
  scope: "interior"
  chat: Id
  before: GapPlan
  after: GapPlan
  repaired: Range[]
  fetched: number
  requests: number
  complete: boolean
  prepared?: CatchUpResult
  stopped?: "bound" | "partial_or_inaccessible" | "fetch_failed"
}
export const validateRepair = (messenger: ServiceDeps["messenger"], options: RepairOptions) => {
  const maxGaps = options.maxGaps ?? GAP_BOUNDS.maxGaps
  const limit = options.limit ?? GAP_BOUNDS.limit
  const timeMs = options.timeMs ?? GAP_BOUNDS.timeMs
  const fetching = messenger.fetching ?? FETCHING
  const pageSize = options.pageSize ?? fetching.page
  for (const [name, value, maximum] of [
    ["max-gaps", maxGaps, 100],
    ["limit", limit, 10_000],
    ["repair-time", timeMs, 300_000],
    ["page-size", pageSize, fetching.maxPageSize ?? fetching.page],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new CliError("validation_error", `${name} must be between 1 and ${maximum}`)
  if (!Number.isSafeInteger(options.pauseMs ?? 0) || (options.pauseMs ?? 0) < 0)
    throw new CliError("validation_error", "pause must not be negative")
}

export const gapsService = (deps: ServiceDeps) => {
  const plan = async (chat: string): Promise<GapPlan> => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, chat, store, account)
    const ordering = (deps.messenger.fetching ?? FETCHING).orderBy ?? "id"
    const held = await store.sync.ranges(account, chatId)
    const gaps = held.slice(1).flatMap((range, index) => {
      const prior = held[index]
      return prior && prior.to + 1 < range.from ? [{ from: prior.to + 1, to: range.from - 1 }] : []
    })
    const knownStart = await store.sync.syncState(account, historyStartKey(chatId))
    const start = knownStart === null ? NaN : Number(knownStart?.value)
    const unknown = { older: !Number.isSafeInteger(start) || !held[0] || held[0].from > start, newer: true as const }
    const identity = { account, chat: chatId, ordering, held }
    return {
      version: 1,
      scope: "interior",
      ...identity,
      limits: { ...GAP_BOUNDS, pageSize: (deps.messenger.fetching ?? FETCHING).page },
      gaps,
      unknown,
      fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    }
  }
  const repair = async (chat: string, options: RepairOptions = {}): Promise<GapRepair> => {
    const maxGaps = options.maxGaps ?? GAP_BOUNDS.maxGaps
    const limit = options.limit ?? GAP_BOUNDS.limit
    const timeMs = options.timeMs ?? GAP_BOUNDS.timeMs
    const fetching = deps.messenger.fetching ?? FETCHING
    const pageSize = options.pageSize ?? fetching.page
    validateRepair(deps.messenger, options)
    const prepare = options.catchUp ?? (deps.searchCatchUp ? {} : false)
    if (prepare) validateCatchUp(deps, prepare)
    deps.guard.check({ chatId: null, key: "store.gaps.repair" }, { reserve: false })
    const before = await plan(chat)
    if (options.fingerprint !== undefined && options.fingerprint !== before.fingerprint)
      throw new CliError("validation_error", "the gap plan changed; inspect it again before repairing")
    const store = await deps.store()
    const holder = randomUUID()
    if (!(await store.sync.claim(before.account, before.chat, "gaps", holder, timeMs + 5000)))
      throw new CliError("validation_error", "another gap repair holds this chat; retry after it finishes")
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeMs)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let fetched = 0
    let requests = 0
    const repaired: Range[] = []
    let stopped: GapRepair["stopped"]
    try {
      for (let round = 0; round < maxGaps; round += 1) {
        const current = await plan(before.chat)
        const gap = current.gaps.at(-1)
        if (!gap) break
        if (signal.aborted || fetched >= limit) {
          stopped = "bound"
          break
        }
        let result: Fetched
        let windowFetched = 0
        try {
          result = await abortable(
            () =>
              archiveService(deps).fetch(before.chat, {
                window: gap,
                onRequest: () => {
                  requests += 1
                },
                limit: limit - fetched,
                pageSize,
                pauseMs: options.pauseMs ?? 1000,
                catchUp: false,
                stop: signal,
                note: options.note ?? (() => {}),
                onPage: (progress) => {
                  windowFetched = progress.fetched
                  options.onPage?.({ ...progress, fetched: fetched + windowFetched })
                },
              }),
            signal,
          )
        } catch {
          fetched += windowFetched
          stopped = signal.aborted ? "bound" : "fetch_failed"
          break
        }
        fetched += result.fetched
        if (!result.windowComplete) {
          stopped = signal.aborted || fetched >= limit ? "bound" : "partial_or_inaccessible"
          break
        }
        repaired.push(gap)
      }
      const after = await plan(before.chat)
      const remainingMs = timeMs - (Date.now() - started)
      const prepared = !prepare
        ? undefined
        : remainingMs <= 0 || signal.aborted
          ? { complete: false, reason: "time_or_abort_bound" as const }
          : await catchUpSearch(
              deps,
              before.chat,
              { ...prepare, timeMs: Math.min(prepare.timeMs ?? 30_000, remainingMs) },
              signal,
            )
      return {
        version: 1,
        scope: "interior",
        chat: before.chat,
        before,
        after,
        repaired,
        fetched,
        requests,
        complete: after.gaps.length === 0,
        ...(prepared === undefined ? {} : { prepared }),
        ...(stopped ? { stopped } : after.gaps.length ? { stopped: "bound" as const } : {}),
      }
    } finally {
      clearTimeout(timer)
      await store.sync.release(before.account, before.chat, "gaps", holder)
    }
  }
  return { plan, repair }
}
