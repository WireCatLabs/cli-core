import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { type ContextSource, contextSource } from "../context/evidence.js"
import { contextSourceKey } from "../context/evidence-response.js"

export interface ProjectGatheringRequest {
  project: { name: string; key?: string; background?: string; aliases?: string[] }
  keywords?: string[]
  people?: { name: string; reference?: string }[]
  sources: ContextSource[]
  scope: "explicit" | "all-connected"
  lookbackDays?: number
  after?: number
  before?: number
  asOf?: number
  fetch?: "none" | "before-read"
  index?: "update" | "as-is"
  budgets?: ProjectGatheringBudgets
  runKey?: string
  checkpoint?: string
  signal?: AbortSignal
}
export interface ProjectGatheringBudgets {
  maxReads?: number
  maxReadBytes?: number
  maxPageBytes?: number
  maxElapsedMs?: number
  maxItems?: number
}
export type ProjectLaneKind = "project" | "key" | "alias" | "keyword" | "person"
export interface ProjectLane {
  id: string
  kinds: ProjectLaneKind[]
  query: string
  people: string[]
}
export type ProjectUnitState = "pending" | "partial" | "done" | "unavailable" | "failed" | "read-limited"
export interface ProjectUnitProgress {
  state: ProjectUnitState
  pages: number
  cursor: { at: number; id: number; scope: string } | null
  code: string | null
}
export type ProjectFetchState = "fetched" | "unsupported" | "failed" | "not-requested"
export interface ProjectGatheringCheckpoint {
  version: 1
  runKey: string
  fingerprint: string
  after: number
  before: number
  asOf: number
  fetched: { state: ProjectFetchState; history: "complete" | "partial" | "unknown" | null; code: string | null }[]
  units: ProjectUnitProgress[]
  seen: string[]
  totals: { reads: number; readBytes: number; items: number; invocations: number }
}

const DAY = 86400000
const MAX_TIME = 8_640_000_000_000_000
export const CONTEXT_CHUNK_DAYS = 90
const LIMITS = { lanes: 16, sources: 32, units: 512, lookbackDays: 730, people: 16 } as const
const BUDGETS = {
  maxReads: [48, 512],
  maxReadBytes: [2097152, 16777216],
  maxPageBytes: [65536, 262144],
  maxElapsedMs: [60000, 600000],
  maxItems: [100, 500],
} as const

const fail = (message: string, param?: string): never => {
  throw new CliError("validation_error", message, param ? { param } : undefined)
}
const known = (value: object, allowed: readonly string[], prefix: string) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) fail(`${prefix}${unknown} is not supported`, `${prefix}${unknown}`)
}
const text = (value: unknown, name: string, max: number) =>
  typeof value === "string" && value.trim() && Buffer.byteLength(value) <= max
    ? value.trim()
    : fail(`${name} needs 1–${max} UTF-8 bytes`, name)
const whole = (value: unknown, name: string, low: number, high: number) =>
  Number.isSafeInteger(value) && (value as number) >= low && (value as number) <= high
    ? (value as number)
    : fail(`${name} must be a whole number from ${low} to ${high}`, name)
const laneQuery = (value: unknown, name: string) => {
  const query = text(value, name, 2048)
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!words.length || words.length > 16) fail(`${name} needs 1–16 literal words`, name)
  return words.join(" ")
}
const list = (value: unknown, name: string, max: number): unknown[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) return fail(`${name} needs at most ${max} entries`, name)
  return value
}

export const projectGatheringRequest = (input: ProjectGatheringRequest, now: number) => {
  if (!input || typeof input !== "object") fail("request needs a project and sources")
  known(
    input,
    [
      "project",
      "keywords",
      "people",
      "sources",
      "scope",
      "lookbackDays",
      "after",
      "before",
      "asOf",
      "fetch",
      "index",
      "budgets",
      "runKey",
      "checkpoint",
      "signal",
    ],
    "",
  )
  if (!input.project || typeof input.project !== "object") fail("project needs a name", "project")
  known(input.project, ["name", "key", "background", "aliases"], "project.")
  const project = {
    name: text(input.project.name, "project.name", 512),
    key: input.project.key === undefined ? null : text(input.project.key, "project.key", 64),
    background:
      input.project.background === undefined ? null : text(input.project.background, "project.background", 8192),
    aliases: list(input.project.aliases, "project.aliases", LIMITS.lanes).map((a, i) =>
      text(a, `project.aliases.${i}`, 512),
    ),
  }
  const keywords = list(input.keywords, "keywords", LIMITS.lanes).map((k, i) => laneQuery(k, `keywords.${i}`))
  const people = list(input.people, "people", LIMITS.people).map((person, i) => {
    if (!person || typeof person !== "object") return fail(`people.${i} needs a name`, `people.${i}`)
    known(person, ["name", "reference"], `people.${i}.`)
    const p = person as { name: unknown; reference?: unknown }
    return {
      name: laneQuery(p.name, `people.${i}.name`),
      reference: p.reference === undefined ? null : text(p.reference, `people.${i}.reference`, 1024),
    }
  })
  if (input.scope !== "explicit" && input.scope !== "all-connected")
    fail("scope must be explicit or all-connected; omitted scope never means every account", "scope")
  const sourceList = list(input.sources, "sources", LIMITS.sources)
  if (!sourceList.length)
    fail("sources needs at least one resolved source; omitted scope never means every account", "sources")
  const sources = sourceList.map((s) => contextSource(s as ContextSource))
  if (new Set(sources.map(contextSourceKey)).size !== sources.length) fail("sources lists one source twice", "sources")

  const lanes: ProjectLane[] = []
  const lane = (kind: ProjectLaneKind, query: string, person?: string) => {
    const key = query.toLowerCase()
    const found = lanes.find((l) => l.query.toLowerCase() === key) ?? {
      id: `l${lanes.length + 1}`,
      kinds: [],
      query,
      people: [],
    }
    if (!lanes.includes(found)) lanes.push(found)
    if (!found.kinds.includes(kind)) found.kinds.push(kind)
    if (person && !found.people.includes(person)) found.people.push(person)
  }
  lane("project", laneQuery(project.name, "project.name"))
  if (project.key) lane("key", laneQuery(project.key, "project.key"))
  for (const [i, a] of project.aliases.entries()) lane("alias", laneQuery(a, `project.aliases.${i}`))
  for (const k of keywords) lane("keyword", k)
  for (const p of people) lane("person", p.name, p.reference ?? p.name)
  if (lanes.length > LIMITS.lanes) fail(`at most ${LIMITS.lanes} distinct search lanes`, "keywords")

  const fetch = input.fetch ?? "none"
  const index = input.index ?? "update"
  if (index !== "update" && index !== "as-is") fail("index must be update or as-is", "index")
  if (fetch !== "none" && fetch !== "before-read") fail("fetch must be none or before-read", "fetch")
  const explicit = input.after !== undefined || input.before !== undefined
  if (explicit && input.lookbackDays !== undefined) fail("give lookbackDays or after/before, not both", "lookbackDays")
  if (explicit && input.after === undefined) fail("an explicit window needs after; before defaults to asOf", "after")
  const asOf = input.asOf === undefined ? null : whole(input.asOf, "asOf", 1, MAX_TIME)
  const lookbackDays = explicit ? null : whole(input.lookbackDays ?? 60, "lookbackDays", 1, LIMITS.lookbackDays)
  const window = explicit
    ? (() => {
        const after = whole(input.after, "after", 0, MAX_TIME)
        const before = whole(input.before ?? asOf ?? now, "before", after + 1, MAX_TIME)
        if (before - after > LIMITS.lookbackDays * DAY)
          fail(`window must not exceed ${LIMITS.lookbackDays} days`, "after")
        return { after, before, asOf: asOf ?? before }
      })()
    : { after: Math.max(0, (asOf ?? now) - (lookbackDays as number) * DAY), before: asOf ?? now, asOf: asOf ?? now }

  if (input.budgets !== undefined && (!input.budgets || typeof input.budgets !== "object"))
    fail("budgets needs whole-run limits", "budgets")
  const given = input.budgets ?? {}
  known(given, Object.keys(BUDGETS), "budgets.")
  const budgets = Object.fromEntries(
    Object.entries(BUDGETS).map(([key, [fallback, max]]) => [
      key,
      whole(given[key as keyof ProjectGatheringBudgets] ?? fallback, `budgets.${key}`, 1, max),
    ]),
  ) as Required<ProjectGatheringBudgets>
  if (budgets.maxPageBytes > budgets.maxReadBytes) budgets.maxPageBytes = budgets.maxReadBytes

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "project-gathering-v1",
        project,
        lanes,
        people,
        sources.map(contextSourceKey),
        input.scope,
        lookbackDays,
        explicit ? [window.after, input.before ?? null] : null,
        asOf,
        fetch,
      ]),
    )
    .digest("hex")
  const runKey = input.runKey === undefined ? fingerprint : text(input.runKey, "runKey", 256)
  if (input.checkpoint !== undefined && typeof input.checkpoint !== "string")
    fail("checkpoint must be text", "checkpoint")
  return {
    project,
    keywords,
    people,
    lanes,
    sources,
    scope: input.scope,
    lookbackDays,
    window,
    fetch,
    index,
    budgets,
    fingerprint,
    runKey,
    checkpoint: input.checkpoint,
    signal: input.signal,
  }
}
export type ProjectGatheringPlan = ReturnType<typeof projectGatheringRequest>

/** Newest chunk first, so a cut budget keeps the most recent evidence of every lane. */
export const contextChunks = (after: number, before: number) => {
  const chunks: { after: number; before: number }[] = []
  for (let end = before; end > after; end -= CONTEXT_CHUNK_DAYS * DAY)
    chunks.push({ after: Math.max(after, end - CONTEXT_CHUNK_DAYS * DAY), before: end })
  return chunks
}

export const projectUnits = (plan: ProjectGatheringPlan, window: { after: number; before: number }) => {
  const units = contextChunks(window.after, window.before).flatMap((chunk) =>
    plan.lanes.flatMap((lane) => plan.sources.map((source, sourceIndex) => ({ lane, source, sourceIndex, chunk }))),
  )
  if (units.length > LIMITS.units)
    fail(`${units.length} lane × source × 90-day reads exceed ${LIMITS.units}; narrow the lanes, sources or window`)
  return units
}

export const seenKey = (ref: string) => createHash("sha256").update(ref).digest("base64url").slice(0, 16)

export const encodeCheckpoint = (checkpoint: ProjectGatheringCheckpoint) =>
  Buffer.from(JSON.stringify(checkpoint)).toString("base64url")

export const decodeCheckpoint = (text: string, plan: ProjectGatheringPlan): ProjectGatheringCheckpoint => {
  let value: ProjectGatheringCheckpoint
  try {
    if (!/^[A-Za-z0-9_-]{1,1048576}$/.test(text)) throw Error()
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"))
  } catch {
    return fail("invalid project gathering checkpoint", "checkpoint")
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.units) ||
    !Array.isArray(value.fetched) ||
    !Array.isArray(value.seen) ||
    !Number.isSafeInteger(value.after) ||
    !Number.isSafeInteger(value.before) ||
    value.after < 0 ||
    value.before <= value.after
  )
    fail("invalid project gathering checkpoint", "checkpoint")
  if (value.runKey !== plan.runKey) fail("checkpoint belongs to another run key", "checkpoint")
  if (value.fingerprint !== plan.fingerprint)
    fail(
      "this run key was started with another request; a resumed run keeps its project, lanes, sources and window",
      "checkpoint",
    )
  return value
}
