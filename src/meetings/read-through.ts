import { CliError } from "@wirecat/cli-base"
import { dateRange, type Predicate, type QueryAst, type QueryNode, timezoneOf } from "@wirecat/cli-base/query"
import type { Missing } from "@wirecat/cli-base/standards"
import type { MeetingItem } from "./item.js"
import { saveSourceMeeting } from "./pull.js"
import { MeetingError, type MeetingList, meetingsList } from "./reads.js"
import { parseMeetingReference } from "./reference.js"
import type { Backend } from "./service-query.js"
import { type ServiceCapability, serviceCallsOf } from "./service-query.js"
import type { FoundMeeting, MeetingSource, MeetingTerm, MeetingWindow } from "./source.js"
import type { MeetingDetails, MeetingFilter, MeetingStore } from "./store.js"

/**
 * `meetings list` asks at most `calls` calls of `find`, each up to `pages` pages; past either the answer says it is not
 * complete. The same three calls as messages search.
 */
export const MEETING_SERVER_BOUNDS = { calls: 3, pages: 2 }

export type MeetingServerSkip =
  | "unsupported"
  | "offline"
  | "read_only"
  | "not_signed_in"
  | "refused"
  | "failed"
  | "no_upcoming"

/** What asking the service did, as messages search's `server` says it. */
export interface MeetingServerReport {
  backend: "server" | "both"
  skipped: MeetingServerSkip | null
  calls: number
  returned: number
  /** Meetings the store did not hold before this read. */
  new: number
  complete: boolean
}

/** Where a read may look and what stops it asking the service; `backend` as typed, so its absence means `both`. */
export interface MeetingServerAccess {
  backend?: Backend
  offline?: boolean
  /** `<PREFIX>_READ_ONLY`: what the service returns is kept in the store, so a locked run reads only the store. */
  readOnly?: boolean
  now?: number
  timezone?: string
}

type FoundIn = NonNullable<MeetingItem["found_in"]>

interface ServerStep {
  report: MeetingServerReport
  /** Store meeting id → whether the store held it before the service returned it. */
  found: Map<number, Exclude<FoundIn, "archive">>
  missing: Missing[]
}

const WHY: Record<MeetingServerSkip, (provider: string) => string> = {
  unsupported: (provider) => `${provider} cannot be asked for meetings here — the answer is the store's`,
  offline: () => "--offline: the service was not asked — the answer is the store's",
  read_only: () => "the process is read-only, and a read keeps what the service returns — the answer is the store's",
  not_signed_in: (provider) => `not signed in to ${provider} — the answer is the store's`,
  refused: (provider) => `${provider} refused the request — the answer is the store's`,
  failed: (provider) => `${provider} could not be read — the answer is the store's`,
  no_upcoming: (provider) => `${provider} lists no meeting before it starts — upcoming ones are not in the answer`,
}

const reasonOf = (error: unknown): MeetingServerSkip => {
  const code = error instanceof CliError ? error.code : undefined
  if (code === "authentication_error") return "not_signed_in"
  if (code === "permission_error") return "refused"
  if (code === "network_error") return "offline"
  return "failed"
}

const refusal = (reason: MeetingServerSkip, provider: string, error?: unknown): unknown =>
  error ??
  new CliError(
    "validation_error",
    `--backend server: ${WHY[reason](provider).replace(/ — .*$/, "")}; use --backend archive or both`,
    { reason },
  )

interface Criteria {
  window: MeetingWindow
  terms: MeetingTerm[]
}

const within = (one: MeetingWindow, other: MeetingWindow): MeetingWindow | undefined => {
  const from = Math.max(one.from ?? -Infinity, other.from ?? -Infinity)
  const to = Math.min(one.to ?? Infinity, other.to ?? Infinity)
  if (from > to) return undefined
  return { ...(Number.isFinite(from) ? { from } : {}), ...(Number.isFinite(to) ? { to } : {}) }
}

const windowOf = (node: Predicate, zone: string, now: number): MeetingWindow => {
  const range = dateRange(
    node.value,
    node.operator === "range" ? (node.upper ?? "*") : node.value,
    node.operator === "range" ? node.lower_inclusive === true : true,
    node.operator === "range" ? node.upper_inclusive === true : true,
    zone,
    node.span,
    now,
  )
  return {
    ...(range.lower === undefined ? {} : { from: range.lower_inclusive ? range.lower : range.lower + 1 }),
    ...(range.upper === undefined ? {} : { to: range.upper_inclusive ? range.upper : range.upper - 1 }),
  }
}

/** Every `find` takes `started_at` as its window; the rest is what the source declared it reads. */
const findsOf = (
  source: MeetingSource & { finds: NonNullable<MeetingSource["finds"]> },
  zone: string,
  now: number,
): ServiceCapability<Predicate, Criteria> => ({
  fields: { ...source.finds.fields, started_at: ["term", "range"] },
  negatable: source.finds.negatable?.filter((field) => field !== "started_at") ?? [],
  maxCalls: MEETING_SERVER_BOUNDS.calls,
  all: { window: {}, terms: [] },
  leaf: (predicate, negated) =>
    predicate.field === "started_at"
      ? { window: windowOf(predicate, zone, now), terms: [] }
      : { window: {}, terms: [{ predicate, negated }] },
  both: (one, other) => {
    const window = within(one.window, other.window)
    return window && { window, terms: [...one.terms, ...other.terms] }
  },
})

/** A window that names a time after `now`: one a source without upcoming meetings cannot answer in full. */
const reachesFuture = ({ from, to }: MeetingWindow, now: number) => (to === undefined ? from !== undefined : to > now)

const heldBefore = async (store: MeetingStore, accountId: number, externalId: string): Promise<boolean> => {
  if (store.meetingByExternalId) return (await store.meetingByExternalId(accountId, externalId)) !== null
  const span = { start: 0, end: 0 }
  const query: QueryAst = {
    version: 1,
    language: "lucene-v1",
    root: { kind: "predicate", field: "provider_id", operator: "term", value: externalId, span },
  }
  return (await store.meetings({ accountId, query, includeDeleted: true, limit: 1 })).length > 0
}

const stepFor = (backend: Backend): ServerStep => ({
  report: {
    backend: backend === "server" ? "server" : "both",
    skipped: null,
    calls: 0,
    returned: 0,
    new: 0,
    complete: true,
  },
  found: new Map(),
  missing: [],
})

/** Keeps one meeting the service returned and records whether the store held it. */
const keep = async (
  source: MeetingSource,
  store: MeetingStore,
  accountId: number,
  now: number,
  step: ServerStep,
  found: FoundMeeting,
  parts: Parameters<typeof saveSourceMeeting>[3],
): Promise<MeetingDetails> => {
  const held = await heldBefore(store, accountId, found.meeting.occurrence.id)
  const details = await saveSourceMeeting(source, store, found.meeting, parts, { accountId, now })
  step.found.set(details.meeting.id, held ? "both" : "server")
  step.report.returned += 1
  if (!held) step.report.new += 1
  return details
}

/**
 * Asks the service for the meetings a `meetings list` query may match and keeps them, so the store query that runs
 * next sees them. The service gets only what it can filter (`serviceCallsOf`): a wider set, never a narrower one.
 * Without a typed `--backend server`, a service that cannot be asked leaves the store's answer and a `missing` line.
 */
export const askServerForList = async (
  source: MeetingSource | undefined,
  store: MeetingStore,
  accountId: number,
  query: QueryAst | undefined,
  access: MeetingServerAccess,
): Promise<ServerStep | undefined> => {
  const backend = access.backend ?? "both"
  if (backend === "archive") return undefined
  const step = stepFor(backend)
  const provider = source?.name ?? "the service"
  const skip = (reason: MeetingServerSkip, error?: unknown): ServerStep => {
    if (backend === "server") throw refusal(reason, provider, error)
    step.report.skipped = reason
    step.report.complete = false
    step.missing.push({ field: "server", why: WHY[reason](provider) })
    return step
  }
  if (!source?.find || !source.finds) return skip("unsupported")
  if (access.offline) return skip("offline")
  if (access.readOnly) return skip("read_only")
  const now = access.now ?? Date.now()
  const finds = source.finds
  const capability = findsOf({ ...source, finds }, timezoneOf(access.timezone), now)
  const { calls, complete } = query
    ? serviceCallsOf(query.root, capability)
    : { calls: [capability.all], complete: true }
  if (!complete) step.report.complete = false
  let asked = calls
  if (finds.upcoming === false) {
    if (calls.some(({ window }) => reachesFuture(window, now)))
      step.missing.push({ field: "upcoming", why: WHY.no_upcoming(provider) })
    asked = calls.flatMap((call) => {
      const window = within(call.window, { to: now })
      return window ? [{ ...call, window }] : []
    })
    if (!asked.length) return skip("no_upcoming")
  }
  const seen = new Set<string>()
  for (const call of asked) {
    let cursor: string | null = null
    for (let page = 0; page < MEETING_SERVER_BOUNDS.pages; page++) {
      step.report.calls += 1
      let answer: Awaited<ReturnType<NonNullable<MeetingSource["find"]>>>
      try {
        answer = await source.find(call.window, call.terms, cursor)
      } catch (error) {
        return skip(reasonOf(error), error)
      }
      for (const found of answer.meetings) {
        if (seen.has(found.meeting.occurrence.id)) continue
        seen.add(found.meeting.occurrence.id)
        try {
          await keep(source, store, accountId, now, step, found, { participants: found.participants })
        } catch {
          step.report.complete = false
        }
      }
      cursor = answer.next
      if (cursor === null) break
      if (page === MEETING_SERVER_BOUNDS.pages - 1) step.report.complete = false
    }
  }
  if (!step.report.complete) {
    const { calls, returned } = step.report
    step.missing.push({
      field: "server",
      why:
        `${provider} was asked ${calls} time(s) and returned ${returned} meeting(s), not every one that may ` +
        "match — narrow the query by started_at",
    })
  }
  return step
}

const anyId = (ids: number[]): QueryNode => {
  const span = { start: 0, end: 0 }
  return {
    kind: "boolean",
    span,
    clauses: ids.map((id) => ({
      occur: "should" as const,
      node: { kind: "predicate" as const, field: "id", operator: "term" as const, value: String(id), span },
    })),
  }
}

/** `meetings list` with the service asked first, as `--backend` says; the store's query and paging decide. */
export type MeetingListThrough = MeetingList & { server?: MeetingServerReport }

export const meetingsListThrough = async (
  source: MeetingSource | undefined,
  store: MeetingStore,
  filter: MeetingFilter & { accountId: number },
  access: MeetingServerAccess,
): Promise<MeetingListThrough> => {
  const step = await askServerForList(source, store, filter.accountId, filter.query, access)
  if (!step) return meetingsList(store, filter)
  const extras = { server: step.report, ...(step.missing.length ? { missing: step.missing } : {}) }
  let narrowed = filter
  if (access.backend === "server") {
    const ids = [...step.found.keys()]
    if (!ids.length)
      return { items: [], page: { mode: "page", limit: filter.limit ?? 100, has_more: false }, ...extras }
    const root = filter.query
      ? ({
          kind: "boolean",
          span: filter.query.root.span,
          clauses: [
            { occur: "must", node: filter.query.root },
            { occur: "must", node: anyId(ids) },
          ],
        } satisfies QueryNode)
      : anyId(ids)
    narrowed = { ...filter, query: { version: 1, language: "lucene-v1", root } }
  }
  const list = await meetingsList(store, narrowed)
  return {
    ...list,
    items: list.items.map((item) => ({ ...item, found_in: step.found.get(Number(item.id)) ?? "archive" })),
    ...extras,
  }
}

/** The account's stored meeting `meeting` names: its store number, its `meeting:` ref, or the service's id. */
const storedMeeting = async (
  store: MeetingStore,
  accountId: number,
  meeting: string,
): Promise<MeetingDetails | null> => {
  const text = meeting.trim()
  const own = (details: MeetingDetails | null) => (details?.meeting.accountId === accountId ? details : null)
  if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text))) {
    const byNumber = own(await store.meeting(Number(text)))
    if (byNumber) return byNumber
  }
  if (text.startsWith("meeting:")) {
    const reference = parseMeetingReference(text)
    if (reference.accountId !== accountId) throw new MeetingError("not_found", "meeting not found")
    return own(await store.meeting(reference.meetingId))
  }
  return store.meetingByExternalId ? own(await store.meetingByExternalId(accountId, text)) : null
}

export interface MeetingShowThrough {
  details: MeetingDetails
  foundIn?: FoundIn
  server?: MeetingServerReport
  missing?: Missing[]
}

/**
 * `meetings show`: the stored meeting `meeting` names (store number first, then `meeting:` ref, then the service's
 * id), read again from the service with its people, transcript and Drive documents and kept, as `--backend` says.
 */
export const meetingShowThrough = async (
  source: MeetingSource | undefined,
  store: MeetingStore,
  accountId: number,
  meeting: string,
  access: MeetingServerAccess,
): Promise<MeetingShowThrough> => {
  if (!meeting.trim()) throw new MeetingError("validation_error", "name a meeting")
  const stored = await storedMeeting(store, accountId, meeting)
  const backend = access.backend ?? "both"
  const notFound = () => new MeetingError("not_found", "meeting not found")
  if (backend === "archive") {
    if (!stored) throw notFound()
    return { details: stored }
  }
  const step = stepFor(backend)
  const provider = source?.name ?? "the service"
  const fromStore = (reason: MeetingServerSkip, error?: unknown): MeetingShowThrough => {
    if (backend === "server") throw refusal(reason, provider, error)
    if (!stored) throw error instanceof CliError && reason !== "failed" ? error : notFound()
    step.report.skipped = reason
    step.report.complete = false
    return {
      details: stored,
      foundIn: "archive",
      server: step.report,
      missing: [{ field: "server", why: WHY[reason](provider) }],
    }
  }
  const providerId = stored?.meeting.externalId ?? (meeting.trim().startsWith("meeting:") ? undefined : meeting.trim())
  if (providerId === undefined) throw notFound()
  if (!source?.get) return fromStore("unsupported")
  if (access.offline) return fromStore("offline")
  if (access.readOnly) return fromStore("read_only")
  step.report.calls = 1
  let full: Awaited<ReturnType<NonNullable<MeetingSource["get"]>>>
  try {
    full = await source.get(providerId)
  } catch (error) {
    return fromStore(reasonOf(error), error)
  }
  if (!full) {
    if (!stored || backend === "server") throw notFound()
    return { details: stored, foundIn: "archive", server: step.report }
  }
  const details = await keep(source, store, accountId, access.now ?? Date.now(), step, full, {
    participants: full.participants,
    transcript: full.transcript,
    documents: full.documents,
  })
  const fresh = (await store.meeting(details.meeting.id)) ?? details
  return { details: fresh, foundIn: step.found.get(details.meeting.id) ?? "server", server: step.report }
}
