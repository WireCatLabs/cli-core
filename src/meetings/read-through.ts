import { CliError } from "@wirecat/cli-base"
import { type Predicate, type QueryAst, timezoneOf } from "@wirecat/cli-base/query"
import type { Issue, Meta, Missing } from "@wirecat/cli-base/standards"
import {
  type Backend,
  rangeOf,
  readsZone,
  type ServiceCapability,
  serviceCallsOf,
  windowOf,
} from "../search/service-query.js"
import { MEETING_QUERY, type MeetingItem } from "./item.js"
import { saveSourceMeeting, sourceMeetingInput } from "./pull.js"
import { MeetingError, type MeetingList, meetingsList } from "./reads.js"
import { parseMeetingReference } from "./reference.js"
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
  | "unreachable"
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
  /** Meetings the service returned that could not be kept, so the store's answer cannot have them. */
  failed: number
  complete: boolean
}

/**
 * Where a read may look and what stops it asking the service; `backend` as typed, so its absence means `both`.
 * `timezone` and `now` read the query's dates the same way on both sides: the service's window and the store's query.
 */
export interface MeetingServerAccess {
  backend?: Backend
  offline?: boolean
  now?: number
  timezone?: string
}

type FoundIn = NonNullable<MeetingItem["found_in"]>

interface ServerStep {
  report: MeetingServerReport
  /** Store meeting id → whether the store held it before the service returned it. */
  found: Map<number, Exclude<FoundIn, "archive">>
  missing: Missing[]
  /** What the host's `meta` says of it: not complete when the service could not be read, cut at the call cap. */
  meta?: Partial<Meta>
}

// A source that has no live read, or no upcoming meetings, answers in full what it can: only a failed read is partial.
const ISSUES: Partial<Record<MeetingServerSkip, [Issue["code"], string]>> = {
  offline: ["permission_error", "meetings.server-offline"],
  unreachable: ["network_error", "meetings.server-unreachable"],
  not_signed_in: ["authentication_error", "meetings.server-signed-out"],
  refused: ["permission_error", "meetings.server-refused"],
  failed: ["provider_error", "meetings.server-failed"],
}
const metaOf = (reason: MeetingServerSkip, provider: string): Partial<Meta> | undefined => {
  const issue = ISSUES[reason]
  return issue && { complete: false, issues: [{ code: issue[0], reason: issue[1], source: provider }] }
}

const WHY: Record<MeetingServerSkip, (provider: string) => string> = {
  unsupported: (provider) => `${provider} cannot be asked for meetings here — the answer is the store's`,
  offline: () => "--offline: the service was not asked — the answer is the store's",
  unreachable: (provider) => `${provider} could not be reached — the answer is the store's`,
  not_signed_in: (provider) => `not signed in to ${provider} — the answer is the store's`,
  refused: (provider) => `${provider} refused the request — the answer is the store's`,
  failed: (provider) => `${provider} could not be read — the answer is the store's`,
  no_upcoming: (provider) => `${provider} lists no meeting before it starts — upcoming ones are not in the answer`,
}

const reasonOf = (error: unknown): MeetingServerSkip => {
  const code = error instanceof CliError ? error.code : undefined
  if (code === "authentication_error") return "not_signed_in"
  if (code === "permission_error") return "refused"
  if (code === "network_error") return "unreachable"
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
      ? { window: windowOf(rangeOf(predicate, zone, now)), terms: [] }
      : { window: {}, terms: [{ predicate, negated }] },
  both: (one, other) => {
    const window = within(one.window, other.window)
    return window && { window, terms: [...one.terms, ...other.terms] }
  },
})

/** A window that reaches past `now`, an open end included: one a source without upcoming meetings cannot answer. */
const reachesFuture = ({ to }: MeetingWindow, now: number) => to === undefined || to > now

const storedByExternalId = async (
  store: MeetingStore,
  accountId: number,
  externalId: string,
): Promise<MeetingDetails | null> => {
  if (store.meetingByExternalId) return store.meetingByExternalId(accountId, externalId)
  const span = { start: 0, end: 0 }
  const query: QueryAst = {
    version: 1,
    language: "lucene-v1",
    root: { kind: "predicate", field: "provider_id", operator: "term", value: externalId, span },
  }
  const [row] = await store.meetings({ accountId, query, includeDeleted: true, limit: 1 })
  return row ? store.meeting(row.id) : null
}

const peopleKey = (people: readonly { email: string | null; displayName: string | null }[]) =>
  JSON.stringify(people.map(({ email, displayName }) => [email ?? "", displayName ?? ""]).sort())

/** Whether keeping what the service returned would change nothing the store holds, so nothing is written. */
const unchanged = (found: FoundMeeting, stored: MeetingDetails, accountId: number): boolean => {
  const participants = found.participants
  const input = sourceMeetingInput(
    found.meeting,
    accountId,
    participants === undefined ? undefined : (participants?.length ?? null),
    stored.meeting,
  )
  const row = stored.meeting
  return (
    row.deletedAt === null &&
    input.title === row.title &&
    input.description === row.description &&
    input.location === row.location &&
    input.joinUrl === row.joinUrl &&
    input.startedAt === row.startedAt &&
    input.endedAt === row.endedAt &&
    input.timezone === row.timezone &&
    JSON.stringify(input.metadata ?? null) === JSON.stringify(row.metadata ?? null) &&
    (input.series === undefined ||
      (input.series.externalId === stored.series?.externalId && input.series.title === stored.series.title)) &&
    (participants == null ||
      (row.participantsCount === participants.length && peopleKey(participants) === peopleKey(stored.participants)))
  )
}

const stepFor = (backend: Backend): ServerStep => ({
  report: {
    backend: backend === "server" ? "server" : "both",
    skipped: null,
    calls: 0,
    returned: 0,
    new: 0,
    failed: 0,
    complete: true,
  },
  found: new Map(),
  missing: [],
})

/**
 * Keeps one meeting the service returned and records whether the store held it. What the record leaves empty keeps
 * the stored value; a list's record that changes nothing is not written (`fresh` is a `show`'s full read).
 */
const keep = async (
  source: MeetingSource,
  store: MeetingStore,
  accountId: number,
  now: number,
  step: ServerStep,
  found: FoundMeeting,
  parts: Parameters<typeof saveSourceMeeting>[3],
  fresh = false,
): Promise<MeetingDetails> => {
  const stored = await storedByExternalId(store, accountId, found.meeting.occurrence.id)
  const details =
    stored && !fresh && unchanged(found, stored, accountId)
      ? stored
      : await saveSourceMeeting(source, store, found.meeting, parts, {
          accountId,
          now,
          ...(stored ? { kept: stored.meeting } : {}),
        })
  step.found.set(details.meeting.id, stored ? "both" : "server")
  step.report.returned += 1
  if (!stored) step.report.new += 1
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
    const meta = metaOf(reason, provider)
    if (meta) step.meta = meta
    return step
  }
  if (!source?.find || !source.finds) return skip("unsupported")
  if (access.offline) return skip("offline")
  const now = access.now ?? Date.now()
  const finds = source.finds
  const capability = findsOf({ ...source, finds }, timezoneOf(access.timezone), now)
  const { calls, complete } = query
    ? serviceCallsOf(query.root, capability)
    : { calls: [capability.all], complete: true }
  let capped = !complete
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
  let failure: unknown
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
        } catch (error) {
          step.report.failed += 1
          failure ??= error
        }
      }
      cursor = answer.next
      if (cursor === null) break
      if (page === MEETING_SERVER_BOUNDS.pages - 1) capped = true
    }
  }
  const issues: Issue[] = []
  if (step.report.failed) {
    issues.push({
      code: failure instanceof CliError ? failure.code : "provider_error",
      reason: "meetings.server-failed",
      source: provider,
    })
    const why = failure instanceof Error ? `: ${failure.message}` : ""
    step.missing.push({
      field: "server",
      why: `${step.report.failed} meeting(s) ${provider} returned could not be kept${why} — the answer is without them`,
    })
  }
  if (capped) {
    issues.push({ code: "outcome_unknown", reason: "meetings.server-capped", source: provider })
    const { calls, returned } = step.report
    step.missing.push({
      field: "server",
      why:
        `${provider} was asked ${calls} time(s) and returned ${returned} meeting(s), not every one that may ` +
        "match — narrow the query by started_at",
    })
  }
  if (issues.length) {
    step.report.complete = false
    step.meta = { complete: false, issues }
  }
  return step
}

/** `meetings list` with the service asked first, as `--backend` says; the store's query and paging decide. */
export type MeetingListThrough = MeetingList & { server?: MeetingServerReport; meta?: Partial<Meta> }

/** As `listThrough`, with `meta.timezone` when the query read a date in a zone, as every store list says it. */
export const meetingsListThrough = async (
  source: MeetingSource | undefined,
  store: MeetingStore,
  filter: MeetingFilter & { accountId: number },
  access: MeetingServerAccess,
): Promise<MeetingListThrough> => {
  const listed = await listThrough(source, store, filter, access)
  if (!filter.query || !readsZone(filter.query, MEETING_TIMES)) return listed
  return { ...listed, meta: { ...listed.meta, timezone: timezoneOf(access.timezone) } }
}

const MEETING_TIMES = new Set(MEETING_QUERY.fields.filter(({ type }) => type === "time").map(({ name }) => name))

const listThrough = async (
  source: MeetingSource | undefined,
  store: MeetingStore,
  filter: MeetingFilter & { accountId: number },
  access: MeetingServerAccess,
): Promise<MeetingListThrough> => {
  const now = access.now ?? Date.now()
  const zoned = { ...filter, timezone: timezoneOf(access.timezone), now }
  const step = await askServerForList(source, store, filter.accountId, filter.query, { ...access, now })
  if (!step) return meetingsList(store, zoned)
  const extras = {
    server: step.report,
    ...(step.missing.length ? { missing: step.missing } : {}),
    ...(step.meta ? { meta: step.meta } : {}),
  }
  const ids = [...step.found.keys()]
  if (access.backend === "server" && !ids.length)
    return { items: [], page: { mode: "page", limit: filter.limit ?? 100, has_more: false }, ...extras }
  const list = await meetingsList(store, access.backend === "server" ? { ...zoned, ids } : zoned)
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
  meta?: Partial<Meta>
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
    const meta = metaOf(reason, provider)
    return {
      details: stored,
      foundIn: "archive",
      server: step.report,
      missing: [{ field: "server", why: WHY[reason](provider) }],
      ...(meta ? { meta } : {}),
    }
  }
  const providerId = stored?.meeting.externalId ?? (meeting.trim().startsWith("meeting:") ? undefined : meeting.trim())
  if (providerId === undefined) throw notFound()
  if (!source?.get) return fromStore("unsupported")
  if (access.offline) return fromStore("offline")
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
  const details = await keep(
    source,
    store,
    accountId,
    access.now ?? Date.now(),
    step,
    full,
    { participants: full.participants, transcript: full.transcript, documents: full.documents },
    true,
  )
  const fresh = (await store.meeting(details.meeting.id)) ?? details
  return { details: fresh, foundIn: step.found.get(details.meeting.id) ?? "server", server: step.report }
}
