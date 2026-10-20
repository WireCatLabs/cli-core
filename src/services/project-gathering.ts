import { CliError } from "@wirecat/cli-base"
import type { ContextEvidenceItem, ContextEvidenceReader, ContextIndex, ContextSource } from "../context/evidence.js"
import { CONTEXT_MAX_READ_BYTES, contextEvidenceFingerprint } from "../context/evidence.js"
import { createContextEvidenceReader } from "./context-evidence.js"
import { excerpt } from "./excerpt.js"
import {
  attachNeighbours,
  documentMatches,
  type ProjectNeighbour,
  type ProjectNeighbourReader,
} from "./project-gathering-around.js"
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
  neighbours?: ProjectNeighbourReader
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
  context: ProjectEvidenceContext
  fingerprint: string
  around?: ProjectNeighbour[] | null
  aroundIssue?: string | null
  /** A document hit with `around`: how many paragraphs after the one it centres on also name a lane word. */
  moreMatches?: number
}
/** Strongest first: a hit that names the project, then one only from a linked chat, then one naming only a person. */
export type ProjectEvidenceContext = "project" | "linked-chat" | "person-only"
export type ProjectGatheringStop = "reads" | "read-bytes" | "elapsed" | "items" | null

const terminal = new Set(["done", "unavailable", "failed"])
const CONTEXTS: ProjectEvidenceContext[] = ["person-only", "linked-chat", "project"]
const contextOf = (lane: ProjectLane): ProjectEvidenceContext =>
  lane.kinds.includes("linked-chat")
    ? "linked-chat"
    : lane.kinds.every((k) => k === "person")
      ? "person-only"
      : "project"

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
  const queries = plan.lanes.flatMap((lane) => (lane.query === null ? [] : [lane.query]))

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

  const usage = { reads: 0, readBytes: 0, aroundBytes: 0, items: 0 }
  const items: ProjectEvidenceItem[] = []
  const byRef = new Map<string, ProjectEvidenceItem>()
  const matchedAgain = new Map<string, Set<string>>()
  const oversized = new Map<string, { ref: string; lanes: string[]; source: number; bytes: number }>()
  let stopped: ProjectGatheringStop = null
  const open = (u: ProjectUnitProgress) => !terminal.has(u.state) && u.state !== "read-limited"

  /** Records another lane finding a reference this run already returned; true when it had. */
  const again = (ref: string, lane: ProjectLane) => {
    const known = byRef.get(ref)
    if (known) {
      if (!known.lanes.includes(lane.id)) known.lanes.push(lane.id)
      const context = contextOf(lane)
      if (CONTEXTS.indexOf(context) > CONTEXTS.indexOf(known.context)) known.context = context
      return true
    }
    if (!seen.has(seenKey(ref))) return false
    matchedAgain.set(ref, (matchedAgain.get(ref) ?? new Set()).add(lane.id))
    return true
  }

  const take = (item: ContextEvidenceItem, lane: ProjectLane, kind: ContextSource["kind"], source: number) => {
    if (again(item.ref, lane)) return
    seen.add(seenKey(item.ref))
    const short = excerpt(item.text, lane.query ?? "", 300, { literal: true })
    const fingerprint = contextEvidenceFingerprint(item)
    const entry: ProjectEvidenceItem = {
      ...item,
      kind,
      source,
      text: short,
      textTruncated: short !== item.text.replace(/\s+/g, " ").trim(),
      fingerprint,
      lanes: [lane.id],
      context: contextOf(lane),
    }
    if (kind === "document" && lane.query !== null && plan.around.before + plan.around.after) {
      const passage = documentMatches(item.text, queries, plan.around)
      entry.around = []
      entry.moreMatches = passage.moreMatches
      for (const part of passage.around) {
        const bytes = Buffer.byteLength(part.text)
        if (bytes > plan.budgets.maxReadBytes - usage.readBytes - usage.aroundBytes) {
          entry.aroundIssue = "read-bytes"
          break
        }
        usage.aroundBytes += bytes
        entry.around.push({ ref: item.ref, at: item.at, sender: null, ...part })
      }
    }
    byRef.set(item.ref, entry)
    items.push(entry)
    usage.items++
  }

  // A resumed run starts at its shallowest open unit: below it no unit is due, and an empty round would end the run.
  const shallowest = progress.reduce((low, u) => (open(u) ? Math.min(low, u.pages) : low), Number.POSITIVE_INFINITY)
  for (let round = shallowest; !stopped; round++) {
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
      const readPage = async (allowance: number, limit: number) => {
        const reader = createContextEvidenceReader(ports.evidence, [unit.source], {
          maxReads: 1,
          maxTotalReadBytes: allowance,
        })
        usage.reads++
        try {
          const page = await reader.read({
            source: unit.source,
            ...(unit.chat === undefined ? { query: unit.lane.query ?? undefined } : { chat: unit.chat }),
            after: unit.chunk.after,
            before: unit.chunk.before,
            limit,
            maxReadBytes: allowance,
            ...(state.cursor ? { cursor: state.cursor } : {}),
            signal,
          })
          usage.readBytes += page.readBytes
          return page
        } catch (error) {
          usage.readBytes += reader.usage().chargedBytes
          throw error
        }
      }
      try {
        let page = await readPage(Math.min(plan.budgets.maxPageBytes, plan.budgets.maxReadBytes - usage.readBytes), 20)
        // A large record another lane already returned is not read again; its page already moves past it.
        const big = page.oversized && !again(page.oversized.ref, unit.lane) ? page.oversized : undefined
        if (big && big.bytes <= CONTEXT_MAX_READ_BYTES) {
          if (big.bytes > plan.budgets.maxReadBytes - usage.readBytes || usage.reads >= plan.budgets.maxReads) {
            state.state = "read-limited"
            state.code = "validation_error"
            continue
          }
          page = await readPage(big.bytes, 1)
        } else if (big) {
          const known = oversized.get(big.ref)
          if (!known)
            oversized.set(big.ref, { ref: big.ref, lanes: [unit.lane.id], source: unit.sourceIndex, bytes: big.bytes })
          else if (!known.lanes.includes(unit.lane.id)) known.lanes.push(unit.lane.id)
        }
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
        if (!(error instanceof CliError)) throw error
        if (error.code === "validation_error" && error.details?.reason === "context.read-budget")
          state.state = "read-limited"
        else state.state = error.code === "not_found" ? "unavailable" : "failed"
        state.code = error.code
      }
    }
  }

  await attachNeighbours(
    // A linked chat's neighbours are already its own lane's evidence.
    items.filter((item) => item.context !== "linked-chat"),
    ports.neighbours,
    plan.around,
    {
      remaining: () => plan.budgets.maxReadBytes - usage.readBytes - usage.aroundBytes,
      charge: (bytes) => {
        usage.aroundBytes += bytes
      },
    },
    (ref) => byRef.has(ref) || seen.has(seenKey(ref)),
    signal,
  )

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
    ...(plan.linkedKey === undefined ? {} : { linkedChats: plan.linkedKey }),
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
    linkedChats: plan.linkedChats.map(({ provider, account, chat, ref, source, lane }) => ({
      provider,
      account,
      chat,
      ref,
      source,
      lane,
      state:
        source === null
          ? ("out-of-scope" as const)
          : units.every((unit, index) => unit.lane.id !== lane || progress[index]?.state === "unavailable")
            ? ("unavailable" as const)
            : ("in-scope" as const),
    })),
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
    oversized: [...oversized.values()],
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
