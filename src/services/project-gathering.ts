import { CliError } from "@wirecat/cli-base"
import type { ContextEvidenceItem, ContextEvidenceReader, ContextIndex, ContextSource } from "../context/evidence.js"
import { createContextEvidenceReader } from "./context-evidence.js"
import { excerpt } from "./excerpt.js"
import {
  decodeCheckpoint,
  encodeCheckpoint,
  type ProjectFetchState,
  type ProjectGatheringCheckpoint,
  type ProjectGatheringRequest,
  type ProjectLane,
  type ProjectUnitProgress,
  projectGatheringRequest,
  projectUnits,
  seenKey,
} from "./project-gathering-request.js"

/** A connector's history fetch into the store; the store reads that follow find what it saved. */
export interface ProjectSourceFetcher {
  fetch(request: { source: ContextSource; after: number; before: number; signal?: AbortSignal }): Promise<{
    status: "fetched" | "unsupported"
    history: "complete" | "partial" | "unknown"
  }>
}
export interface ProjectGatheringPorts {
  evidence: ContextEvidenceReader
  fetcher?: ProjectSourceFetcher
  index?: ContextIndex
  now?: () => number
}
export interface ProjectIndexCatchUp {
  state: "updated" | "as-is" | "unavailable" | "failed"
  mail: number
  documents: number
  code: string | null
}
export interface ProjectEvidenceItem extends Omit<ContextEvidenceItem, "text"> {
  kind: ContextSource["kind"]
  source: number
  text: string
  textTruncated: boolean
  lanes: string[]
  context: "project" | "person-only"
}
export type ProjectGatheringStop = "reads" | "read-bytes" | "elapsed" | "items" | null

const terminal = new Set(["done", "unavailable", "failed"])

export const gatherProjectEvidence = async (ports: ProjectGatheringPorts, request: ProjectGatheringRequest) => {
  if (!ports?.evidence || typeof ports.evidence.read !== "function")
    throw new CliError("configuration_error", "stored context reads are unavailable in this store")
  const now = ports.now ?? Date.now
  const started = now()
  const plan = projectGatheringRequest(request, started)
  const previous = plan.checkpoint === undefined ? null : decodeCheckpoint(plan.checkpoint, plan)
  const window = previous ?? plan.window
  const units = projectUnits(plan, window)
  // A default that cannot finish one round would leave whole searches or sources unread; an explicit one is kept.
  if (request.budgets?.maxReads === undefined) plan.budgets.maxReads = Math.min(512, Math.max(48, units.length))
  if (previous && (previous.units.length !== units.length || previous.fetched.length !== plan.sources.length))
    throw new CliError("validation_error", "invalid project gathering checkpoint", { param: "checkpoint" })
  const progress: ProjectUnitProgress[] =
    previous?.units.map((u) => ({ ...u })) ??
    units.map(() => ({ state: "pending", pages: 0, cursor: null, code: null }))
  const fetched: ProjectGatheringCheckpoint["fetched"] =
    previous?.fetched.map((f) => ({ ...f })) ??
    plan.sources.map(() => ({ state: "not-requested" as ProjectFetchState, history: null, code: null }))
  const seen = new Set(previous?.seen ?? [])
  const signal = plan.signal

  if (plan.fetch === "before-read" && !ports.fetcher)
    throw new CliError("configuration_error", "this host cannot fetch source history; use fetch none", {
      param: "fetch",
    })
  if (plan.fetch === "before-read" && ports.fetcher)
    for (const [index, source] of plan.sources.entries()) {
      if (fetched[index]?.state !== "not-requested") continue
      signal?.throwIfAborted()
      try {
        const answer = await ports.fetcher.fetch({ source, after: window.after, before: window.before, signal })
        if (
          !["fetched", "unsupported"].includes(answer?.status) ||
          !["complete", "partial", "unknown"].includes(answer?.history)
        )
          throw new CliError("invalid_response", "source fetch returned an unknown status")
        fetched[index] = { state: answer.status, history: answer.history, code: null }
      } catch (error) {
        signal?.throwIfAborted()
        if (!(error instanceof CliError)) throw error
        fetched[index] = { state: "failed", history: null, code: error.code }
      }
    }

  const indexed: ProjectIndexCatchUp = { state: "as-is", mail: 0, documents: 0, code: null }
  const kinds = [...new Set(plan.sources.map((source) => source.kind))].filter((kind) => kind !== "message")
  if (plan.index === "update" && kinds.length) {
    signal?.throwIfAborted()
    if (!ports.index || typeof ports.index.catchUp !== "function") indexed.state = "unavailable"
    else
      try {
        const done = await ports.index.catchUp({ kinds, signal })
        if (!Number.isSafeInteger(done?.mail) || !Number.isSafeInteger(done?.documents))
          throw new CliError("invalid_response", "index catch-up returned invalid counts")
        Object.assign(indexed, { state: "updated", mail: done.mail, documents: done.documents })
      } catch (error) {
        signal?.throwIfAborted()
        if (!(error instanceof CliError)) throw error
        Object.assign(indexed, { state: "failed", code: error.code })
      }
  }

  const usage = { reads: 0, readBytes: 0, items: 0 }
  const items: ProjectEvidenceItem[] = []
  const byRef = new Map<string, ProjectEvidenceItem>()
  const matchedAgain = new Map<string, Set<string>>()
  let stopped: ProjectGatheringStop = null
  const open = (u: ProjectUnitProgress) => !terminal.has(u.state) && u.state !== "read-limited"

  const take = (item: ContextEvidenceItem, lane: ProjectLane, kind: ContextSource["kind"], source: number) => {
    const known = byRef.get(item.ref)
    if (known) {
      if (!known.lanes.includes(lane.id)) known.lanes.push(lane.id)
      if (!lane.kinds.every((k) => k === "person")) known.context = "project"
      return
    }
    const key = seenKey(item.ref)
    if (seen.has(key)) {
      matchedAgain.set(item.ref, (matchedAgain.get(item.ref) ?? new Set()).add(lane.id))
      return
    }
    seen.add(key)
    const short = excerpt(item.text, lane.query, 300, { literal: true })
    const entry: ProjectEvidenceItem = {
      ...item,
      kind,
      source,
      text: short,
      textTruncated: short !== item.text.replace(/\s+/g, " ").trim(),
      lanes: [lane.id],
      context: lane.kinds.every((k) => k === "person") ? "person-only" : "project",
    }
    byRef.set(item.ref, entry)
    items.push(entry)
    usage.items++
  }

  for (let round = 0; !stopped; round++) {
    const due = progress.flatMap((u, index) => (open(u) && u.pages <= round ? [index] : []))
    if (!due.length) break
    for (const index of due) {
      const unit = units[index],
        state = progress[index]
      if (!unit || !state) continue
      signal?.throwIfAborted()
      stopped =
        usage.reads >= plan.budgets.maxReads
          ? "reads"
          : usage.readBytes >= plan.budgets.maxReadBytes
            ? "read-bytes"
            : now() - started >= plan.budgets.maxElapsedMs
              ? "elapsed"
              : usage.items >= plan.budgets.maxItems
                ? "items"
                : null
      if (stopped) break
      const allowance = Math.min(plan.budgets.maxPageBytes, plan.budgets.maxReadBytes - usage.readBytes)
      const reader = createContextEvidenceReader(ports.evidence, [unit.source], {
        maxReads: 1,
        maxTotalReadBytes: allowance,
      })
      usage.reads++
      try {
        const page = await reader.read({
          source: unit.source,
          query: unit.lane.query,
          after: unit.chunk.after,
          before: unit.chunk.before,
          limit: 20,
          maxReadBytes: allowance,
          ...(state.cursor ? { cursor: state.cursor } : {}),
          signal,
        })
        usage.readBytes += page.readBytes
        state.pages++
        state.code = page.coverage.index === "ready" ? null : `index-${page.coverage.index}`
        for (const item of page.items) take(item, unit.lane, unit.source.kind, unit.sourceIndex)
        if (!page.coverage.available) state.state = "unavailable"
        else if (page.next) {
          state.state = "partial"
          state.cursor = page.next
        } else {
          state.state = "done"
          state.cursor = null
        }
      } catch (error) {
        signal?.throwIfAborted()
        usage.readBytes += reader.usage().chargedBytes
        if (!(error instanceof CliError)) throw error
        if (error.code === "validation_error" && error.details?.reason === "context.read-budget")
          state.state = "read-limited"
        else state.state = error.code === "not_found" ? "unavailable" : "failed"
        state.code = error.code
      }
    }
  }

  const totals = {
    reads: (previous?.totals.reads ?? 0) + usage.reads,
    readBytes: (previous?.totals.readBytes ?? 0) + usage.readBytes,
    items: (previous?.totals.items ?? 0) + usage.items,
    invocations: (previous?.totals.invocations ?? 0) + 1,
  }
  const resumable = progress.some((u) => !terminal.has(u.state))
  const checkpoint: ProjectGatheringCheckpoint = {
    version: 1,
    runKey: plan.runKey,
    fingerprint: plan.fingerprint,
    after: window.after,
    before: window.before,
    asOf: window.asOf,
    fetched,
    units: progress.map((u) => (u.state === "read-limited" ? { ...u, state: "partial" } : u)),
    seen: [...seen],
    totals,
  }
  return {
    schemaVersion: 1 as const,
    runKey: plan.runKey,
    fingerprint: plan.fingerprint,
    resumed: previous !== null,
    project: plan.project,
    window: {
      after: window.after,
      before: window.before,
      asOf: window.asOf,
      lookbackDays: plan.lookbackDays,
      basis: plan.lookbackDays === null ? ("explicit" as const) : ("lookback" as const),
      timeBasis: "per-item-time-kind" as const,
    },
    scope: { origin: plan.scope, sources: plan.sources },
    lanes: plan.lanes,
    fetch: fetched.map((f, index) => ({ source: index, ...f })),
    index: indexed,
    units: units.map((unit, index) => ({
      lane: unit.lane.id,
      source: unit.sourceIndex,
      after: unit.chunk.after,
      before: unit.chunk.before,
      state: progress[index]?.state ?? "pending",
      pages: progress[index]?.pages ?? 0,
      issue: progress[index]?.code ?? null,
    })),
    items,
    matchedAgain: [...matchedAgain].map(([ref, lanes]) => ({ ref, lanes: [...lanes] })),
    usage: { ...usage, elapsedMs: now() - started },
    totals,
    stopped,
    complete: !resumable,
    completeness: "unknown" as const,
    checkpoint: resumable ? encodeCheckpoint(checkpoint) : null,
  }
}
export type ProjectGathering = Awaited<ReturnType<typeof gatherProjectEvidence>>
