import { CliError } from "@wirecat/cli-base"
import { joinKeyOf, MEETING_FINDINGS_KIND, parseMeetingReference } from "../../meetings/index.js"
import type { SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import { eventWindow } from "./calendar-events.js"
import { COUNTERPART_ROLE, linkKind } from "./link-kinds.js"
import { samePersons } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

export const MEETING_ROW_KINDS = ["meeting", "call", "event"] as const
export type MeetingRowKind = (typeof MEETING_ROW_KINDS)[number]

const DAY = 86_400_000

/**
 * The calendar event a meeting joins on the same room and time: a live, uncancelled copy whose `join_key` is the
 * meeting's exactly (an empty key names no room) and whose event overlaps it. The nearest start wins.
 */
const JOINED = `(SELECT ce.event_id FROM calendar_entries ce JOIN events je ON je.id = ce.event_id
  WHERE m.join_key <> '' AND ce.join_key = m.join_key AND ce.deleted_at IS NULL AND ce.status <> 'cancelled'
    AND je.deleted_at IS NULL AND je.starts_at < coalesce(m.ended_at, m.started_at + 1)
    AND coalesce(je.ends_at, je.starts_at + 1) > m.started_at
  ORDER BY abs(je.starts_at - m.started_at), je.id LIMIT 1)`

/**
 * Each meeting's row: the calendar event it is linked to; else the event it shares a room and a time with; else the
 * event made from it (`origin = 'auto'`); else its own row.
 */
const HOME = `CASE
  WHEN m.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM calendar_entries hc WHERE hc.event_id = m.event_id)
    AND EXISTS (SELECT 1 FROM events he WHERE he.id = m.event_id AND he.deleted_at IS NULL) THEN m.event_id
  ELSE coalesce(${JOINED}, (SELECT he.id FROM events he WHERE he.id = m.event_id AND he.deleted_at IS NULL)) END`

export interface MeetingListFilter {
  /** Rows that end after this instant. */
  from?: number
  /** Rows that start before this instant. */
  to?: number
  /** The local days an all-day event is compared by, as `EventFilter` has them. */
  fromDate?: string
  toDate?: string
  /** Rows with a calendar copy or a meeting in these stored accounts; every account when left out. */
  accountIds?: readonly number[]
  kinds?: readonly MeetingRowKind[]
  /** A person's id: rows they were invited to, took part in, or were called by. */
  personId?: number
  hasTranscript?: boolean
  /** Words every title holds, compared folded. */
  titleWords?: readonly string[]
  newest?: boolean
  limit: number
  offset: number
}

export interface MeetingRowSource {
  provider: string
  account: string
  /** `calendar`: a copy in a calendar; `meeting`: a meeting provider's record. */
  via: "calendar" | "meeting"
  /** The calendar's title, for a calendar copy. */
  calendar: string | null
  /** `meeting:<account>/<id>` for a meeting, `event:<id>` for a calendar copy. */
  ref: string
}

export interface MeetingRowParticipant {
  name: string | null
  email: string | null
  /** `person:<id>` when the store links the address or account to a person. */
  person: string | null
  organizer: boolean
}

export interface MeetingRowDocument {
  ref: string
  title: string | null
  role: string | null
}

export interface MeetingRow {
  type: "event" | "meeting"
  id: number
  kind: MeetingRowKind
  title: string | null
  startsAt: number | null
  endsAt: number | null
  allDay: boolean
  timezone: string | null
  status: string | null
  url: string | null
  /** Each distinct join link, `provider:account` of the copy or meeting that gave it. */
  links: { source: string; url: string }[]
  /** The meetings on this row, by their stored ids, oldest first. */
  meetings: { id: number; accountId: number }[]
  sources: MeetingRowSource[]
  participants: MeetingRowParticipant[]
  hasRecording: boolean
  hasTranscript: boolean
  hasSummary: boolean
  documents: MeetingRowDocument[]
  /** Findings in batches still waiting for the owner that cite one of the row's meetings. */
  pendingFindings: number
  /** Every findings batch citing one of its meetings, newest first, with how many of its findings do. */
  findings: { id: string; status: "proposed" | "reviewed"; findings: number }[]
}

export interface ListedAccount {
  id: number
  provider: string
  account: string
  name: string | null
}

export interface MeetingListing {
  /** Every account holding a calendar or a meeting: what a list reads when no source narrows it. */
  meetingAccounts(): Promise<ListedAccount[]>
  /** Meetings, calls and events as one row per real meeting, newest first unless `newest` is false. */
  meetingRows(filter: MeetingListFilter): Promise<{ items: MeetingRow[]; total: number }>
  /** The row an `event:<id>` or a meeting (by account and id) is on, the same way a list shows it. */
  meetingRow(target: { event: number } | { meeting: number }): Promise<MeetingRow | undefined>
}

export const accountOf = (row: Record<string, unknown>): ListedAccount => ({
  id: Number(row.id),
  provider: String(row.provider),
  account: String(row.external_id),
  name: row.name == null ? null : String(row.name),
})

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

const roomOf = (url: unknown) => (url == null ? null : (joinKeyOf(String(url)) ?? String(url)))
const str = (value: unknown) => (value == null ? null : String(value))
const num = (value: unknown) => (value == null ? null : Number(value))
const ids = (values: readonly number[]) => JSON.stringify(values)

interface Built {
  sql: string
  params: SqlValue[]
}

/** The rows of a window, before any filter: `type`, `id`, its times, and the meetings on it. */
const rowsOf = (context: StoreContext, filter: MeetingListFilter): Built => {
  const { database } = context
  const window = eventWindow(database, filter)
  const meetingWindow: string[] = []
  const meetingParams: SqlValue[] = []
  // Meetings a day either side are read for their homes: an event's own meeting may start a little outside it.
  if (filter.from !== undefined) {
    meetingWindow.push("m.started_at >= ?")
    meetingParams.push(filter.from - DAY)
  }
  if (filter.to !== undefined) {
    meetingWindow.push("m.started_at < ?")
    meetingParams.push(filter.to + DAY)
  }
  const ownWindow: string[] = []
  const ownParams: SqlValue[] = []
  if (filter.from !== undefined) {
    ownWindow.push("coalesce(m.ended_at, m.started_at + 1) > ?")
    ownParams.push(filter.from)
  }
  if (filter.to !== undefined) {
    ownWindow.push("m.started_at < ?")
    ownParams.push(filter.to)
  }
  const and = (clauses: string[]) => clauses.map((clause) => ` AND ${clause}`).join("")
  return {
    sql: `WITH mh AS MATERIALIZED (
        SELECT m.id AS meeting_id, m.account_id, ${HOME} AS event_id FROM meetings m
        WHERE m.deleted_at IS NULL AND m.started_at IS NOT NULL${and(meetingWindow)}
      ),
      mg AS MATERIALIZED (
        SELECT event_id, json_group_array(meeting_id) AS meetings FROM mh WHERE event_id IS NOT NULL GROUP BY event_id
      ),
      u AS (
        SELECT 'event' AS type, e.id, e.starts_at AS starts_at, e.ends_at AS ends_at, e.title FROM events e
        WHERE e.deleted_at IS NULL${and(window.clauses)}
          AND (EXISTS (SELECT 1 FROM calendar_entries rc WHERE rc.event_id = e.id)
            OR e.id IN (SELECT event_id FROM mg) OR e.origin = 'owner')
        UNION ALL
        SELECT 'meeting', m.id, m.started_at, m.ended_at, m.title FROM meetings m JOIN mh ON mh.meeting_id = m.id
        WHERE mh.event_id IS NULL${and(ownWindow)}
      ),
      r AS (
        SELECT u.*, CASE WHEN u.type = 'meeting' THEN json_array(u.id) ELSE coalesce(mg.meetings, '[]') END AS meetings,
          mg.event_id IS NOT NULL AS has_meeting
        FROM u LEFT JOIN mg ON u.type = 'event' AND mg.event_id = u.id
      )`,
    params: [...meetingParams, ...window.params, ...ownParams],
  }
}

/** The meetings on a row of `r`, a JSON list of their ids. */
const ROW_MEETINGS = "r.meetings"

const KIND = `(CASE
  WHEN r.type = 'meeting' THEN (SELECT CASE WHEN a.provider = 'phone' THEN 'call' ELSE 'meeting' END
    FROM meetings km JOIN accounts a ON a.id = km.account_id WHERE km.id = r.id)
  WHEN EXISTS (SELECT 1 FROM calendar_entries kc WHERE kc.event_id = r.id AND kc.event_type = 'call') THEN 'call'
  WHEN r.has_meeting THEN 'meeting'
  ELSE 'event' END)`

const inRowMeetings = (condition: string) =>
  `EXISTS (SELECT 1 FROM json_each(${ROW_MEETINGS}) rm WHERE ${condition.replaceAll("{m}", "rm.value")})`

const filtersOf = (database: StoreContext["database"], filter: MeetingListFilter): Built => {
  const clauses: string[] = []
  const params: SqlValue[] = []
  if (filter.kinds?.length) {
    clauses.push(`${KIND} IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(filter.kinds))
  }
  if (filter.accountIds !== undefined) {
    if (filter.accountIds.length === 0) invalid("accountIds names no account")
    clauses.push(
      `((r.type = 'event' AND EXISTS (SELECT 1 FROM calendar_entries sc JOIN calendars s ON s.id = sc.calendar_id
          WHERE sc.event_id = r.id AND s.account_id IN (SELECT value FROM json_each(?))))
        OR ${inRowMeetings("(SELECT account_id FROM meetings WHERE id = {m}) IN (SELECT value FROM json_each(?))")})`,
    )
    params.push(ids(filter.accountIds), ids(filter.accountIds))
  }
  if (filter.personId !== undefined) {
    const people = ids(samePersons(database, filter.personId))
    clauses.push(
      `((r.type = 'event' AND (EXISTS (SELECT 1 FROM calendar_entries pc JOIN calendar_entry_participants pp
            ON pp.entry_id = pc.id JOIN identity_links pl ON pl.identity_id = pp.identity_id
          WHERE pc.event_id = r.id AND pl.person_id IN (SELECT value FROM json_each(?)))
        OR EXISTS (SELECT 1 FROM links cl WHERE cl.from_type = 'event' AND cl.from_id = r.id AND cl.to_type = 'person'
          AND cl.kind = ${linkKind("related-to")} AND cl.role = '${COUNTERPART_ROLE}'
          AND cl.to_id IN (SELECT value FROM json_each(?)))))
        OR ${inRowMeetings(
          "EXISTS (SELECT 1 FROM meeting_participants mp JOIN identity_links ml ON ml.identity_id = mp.identity_id " +
            "WHERE mp.meeting_id = {m} AND ml.person_id IN (SELECT value FROM json_each(?)))",
        )})`,
    )
    params.push(people, people, people)
  }
  if (filter.hasTranscript !== undefined) {
    clauses.push(
      `${filter.hasTranscript ? "" : "NOT "}${inRowMeetings(
        "EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.meeting_id = {m} AND t.deleted_at IS NULL " +
          "AND t.superseded_at IS NULL)",
      )}`,
    )
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

/** Every findings batch citing one of these meetings, with how many of its findings cite each. */
const citingBatches = (
  database: StoreContext["database"],
  meetingIds: ReadonlySet<number>,
): { id: string; status: "proposed" | "reviewed"; cited: Map<number, number> }[] => {
  if (meetingIds.size === 0) return []
  const batches = database
    .prepare("SELECT id, status, payload FROM proposed_actions WHERE kind = ? ORDER BY id DESC")
    .all(MEETING_FINDINGS_KIND)
  const found: { id: string; status: "proposed" | "reviewed"; cited: Map<number, number> }[] = []
  for (const batch of batches) {
    let payload: { findings?: { evidence?: { reference?: unknown }[] }[] }
    try {
      payload = JSON.parse(String(batch.payload))
    } catch {
      continue
    }
    const cited = new Map<number, number>()
    for (const finding of payload.findings ?? []) {
      const meetings = new Set<number>()
      for (const evidence of finding.evidence ?? []) {
        if (typeof evidence.reference !== "string") continue
        try {
          const meeting = parseMeetingReference(evidence.reference).meetingId
          if (meetingIds.has(meeting)) meetings.add(meeting)
        } catch {}
      }
      for (const meeting of meetings) cited.set(meeting, (cited.get(meeting) ?? 0) + 1)
    }
    if (cited.size > 0)
      found.push({ id: String(batch.id), status: batch.status === "proposed" ? "proposed" : "reviewed", cited })
  }
  return found
}

interface Page {
  type: "event" | "meeting"
  id: number
  meetingIds: number[]
}

/** Everything a page of rows shows, read once per page: a query per kind of fact, never one per row. */
const hydrate = (database: StoreContext["database"], page: Page[]): MeetingRow[] => {
  const eventIds = page.filter(({ type }) => type === "event").map(({ id }) => id)
  const meetingIds = [...new Set(page.flatMap(({ meetingIds }) => meetingIds))]
  const events = new Map(
    database
      .prepare("SELECT * FROM events WHERE id IN (SELECT value FROM json_each(?))")
      .all(ids(eventIds))
      .map((row) => [Number(row.id), row]),
  )
  const entries = database
    .prepare(
      `SELECT ce.id, ce.event_id, ce.join_url, ce.timezone, ce.status, ce.deleted_at, ce.event_type, c.title AS calendar, a.provider,
         a.external_id AS account FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id
         JOIN accounts a ON a.id = c.account_id WHERE ce.event_id IN (SELECT value FROM json_each(?))
         ORDER BY ce.deleted_at IS NOT NULL, ce.id`,
    )
    .all(ids(eventIds))
  const meetings = new Map(
    database
      .prepare(
        `SELECT m.*, a.provider, a.external_id AS account,
           EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.meeting_id = m.id AND t.deleted_at IS NULL
             AND t.superseded_at IS NULL) AS has_transcript,
           EXISTS (SELECT 1 FROM meeting_summaries s WHERE s.meeting_id = m.id) AS has_summary,
           (EXISTS (SELECT 1 FROM attachments ra WHERE ra.attachable_type = 'meeting' AND ra.attachable_id = m.id
               AND (ra.kind IN ('audio', 'video') OR ra.mime LIKE 'audio/%' OR ra.mime LIKE 'video/%'))
             OR EXISTS (SELECT 1 FROM links rl WHERE rl.from_type = 'meeting' AND rl.from_id = m.id
               AND rl.kind = 'attached' AND rl.role = 'recording')) AS has_recording
         FROM meetings m JOIN accounts a ON a.id = m.account_id WHERE m.id IN (SELECT value FROM json_each(?))`,
      )
      .all(ids(meetingIds))
      .map((row) => [Number(row.id), row]),
  )
  const people = database
    .prepare(
      `SELECT 'event' AS type, ce.event_id AS owner, p.name, p.email, p.organizer, l.person_id
         FROM calendar_entries ce JOIN calendar_entry_participants p ON p.entry_id = ce.id
         LEFT JOIN identity_links l ON l.identity_id = p.identity_id
         WHERE ce.event_id IN (SELECT value FROM json_each(?)) AND ce.deleted_at IS NULL AND p.resource = 0
       UNION ALL
       SELECT 'meeting', mp.meeting_id, mp.display_name, mp.email, mp.role = 'host', l.person_id
         FROM meeting_participants mp LEFT JOIN identity_links l ON l.identity_id = mp.identity_id
         WHERE mp.meeting_id IN (SELECT value FROM json_each(?))
       UNION ALL
       SELECT 'event', cl.from_id, pe.name, NULL, 0, cl.to_id FROM links cl JOIN persons pe ON pe.id = cl.to_id
         WHERE cl.from_type = 'event' AND cl.from_id IN (SELECT value FROM json_each(?)) AND cl.to_type = 'person'
           AND cl.kind = ${linkKind("related-to")} AND cl.role = '${COUNTERPART_ROLE}'`,
    )
    .all(ids(eventIds), ids(meetingIds), ids(eventIds))
  const documents = database
    .prepare(
      `SELECT 'meeting' AS type, l.from_id AS owner, l.to_id, l.role, d.title FROM links l JOIN documents d ON d.id = l.to_id
         WHERE l.from_type = 'meeting' AND l.from_id IN (SELECT value FROM json_each(?)) AND l.kind = 'attached'
           AND l.to_type = 'document' AND d.deleted_at IS NULL
       UNION ALL
       SELECT 'event', ce.event_id, l.to_id, l.role, d.title FROM links l JOIN calendar_entries ce ON ce.id = l.from_id
         JOIN documents d ON d.id = l.to_id WHERE l.from_type = 'calendar_entry' AND l.kind = 'attached'
           AND l.to_type = 'document' AND ce.event_id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL`,
    )
    .all(ids(meetingIds), ids(eventIds))
  const batches = citingBatches(database, new Set(meetingIds))
  return page.map(({ type, id, meetingIds: own }) => {
    const held = own.flatMap((one) => {
      const row = meetings.get(one)
      return row ? [row] : []
    })
    held.sort((a, b) => Number(a.started_at) - Number(b.started_at) || Number(a.id) - Number(b.id))
    const event = type === "event" ? events.get(id) : undefined
    const first = held[0]
    const copies = type === "event" ? entries.filter((entry) => Number(entry.event_id) === id) : []
    const live = copies.filter((entry) => entry.deleted_at == null)
    const sources: MeetingRowSource[] = [
      ...copies.map((entry) => ({
        provider: String(entry.provider),
        account: String(entry.account),
        via: "calendar" as const,
        calendar: str(entry.calendar),
        ref: `event:${id}`,
      })),
      ...held.map((meeting) => ({
        provider: String(meeting.provider),
        account: String(meeting.account),
        via: "meeting" as const,
        calendar: null,
        ref: `meeting:${meeting.account_id}/${meeting.id}`,
      })),
    ].filter(
      (source, index, all) =>
        all.findIndex(
          (other) =>
            other.provider === source.provider &&
            other.account === source.account &&
            other.calendar === source.calendar &&
            other.ref === source.ref,
        ) === index,
    )
    const participants = new Map<string, MeetingRowParticipant>()
    for (const person of people) {
      const mine =
        (person.type === "event" && type === "event" && Number(person.owner) === id) ||
        (person.type === "meeting" && own.includes(Number(person.owner)))
      if (!mine) continue
      const ref = person.person_id == null ? null : `person:${person.person_id}`
      const email = str(person.email)
      const key = ref ?? (email ? fold(email) : `name:${str(person.name) ?? ""}`)
      const held = participants.get(key)
      participants.set(key, {
        name: held?.name ?? str(person.name),
        email: held?.email ?? email,
        person: ref,
        organizer: (held?.organizer ?? false) || Number(person.organizer) === 1,
      })
    }
    const linked = new Map<number, MeetingRowDocument>()
    for (const document of documents) {
      const mine =
        (document.type === "meeting" && own.includes(Number(document.owner))) ||
        (document.type === "event" && type === "event" && Number(document.owner) === id)
      if (mine && !linked.has(Number(document.to_id)))
        linked.set(Number(document.to_id), {
          ref: `document:${document.to_id}`,
          title: str(document.title),
          role: str(document.role),
        })
    }
    const startsAt = num(event ? event.starts_at : first?.started_at)
    // The same order as KIND, which a filter by kind reads in SQL.
    const kind: MeetingRowKind =
      type === "meeting"
        ? first?.provider === "phone"
          ? "call"
          : "meeting"
        : copies.some((entry) => entry.event_type === "call")
          ? "call"
          : held.length > 0
            ? "meeting"
            : "event"
    return {
      type,
      id,
      kind,
      title: str(event?.title ?? first?.title) ?? str(first?.title),
      startsAt,
      endsAt: num(event ? event.ends_at : first?.ended_at),
      allDay: Number(event?.all_day ?? 0) === 1,
      timezone: str(event?.timezone ?? live.find((entry) => entry.timezone != null)?.timezone ?? first?.timezone),
      links: [
        ...live.map((entry) => ({ source: `${entry.provider}:${entry.account}`, url: entry.join_url })),
        ...held.map((meeting) => ({ source: `${meeting.provider}:${meeting.account}`, url: meeting.join_url })),
      ].flatMap(({ source, url }, index, all) =>
        // One room shared by a link with a passcode and one without is one link: the first, the calendar's.
        url == null || all.findIndex((other) => roomOf(other.url) === roomOf(url)) !== index
          ? []
          : [{ source, url: String(url) }],
      ),
      status: str(event?.status),
      url: str(
        live.find((entry) => entry.join_url != null)?.join_url ?? held.find((m) => m.join_url != null)?.join_url,
      ),
      meetings: held.map((meeting) => ({ id: Number(meeting.id), accountId: Number(meeting.account_id) })),
      sources,
      participants: [...participants.values()],
      hasRecording: held.some((meeting) => Number(meeting.has_recording) === 1),
      hasTranscript: held.some((meeting) => Number(meeting.has_transcript) === 1),
      hasSummary: held.some((meeting) => Number(meeting.has_summary) === 1),
      documents: [...linked.values()],
      pendingFindings: batches
        .filter(({ status }) => status === "proposed")
        .reduce((sum, { cited }) => sum + own.reduce((mine, meeting) => mine + (cited.get(meeting) ?? 0), 0), 0),
      findings: batches.flatMap(({ id, status, cited }) => {
        const findings = own.reduce((mine, meeting) => mine + (cited.get(meeting) ?? 0), 0)
        return findings > 0 ? [{ id, status, findings }] : []
      }),
    }
  })
}

const pageOf = (row: Record<string, unknown>): Page => ({
  type: row.type === "meeting" ? "meeting" : "event",
  id: Number(row.id),
  meetingIds: (JSON.parse(String(row.meetings ?? "[]")) as unknown[]).map(Number),
})

export const meetingListingOver = (context: StoreContext): MeetingListing => {
  const { database } = context
  return {
    meetingAccounts: async () =>
      database
        .prepare(
          "SELECT id, provider, external_id, name FROM accounts WHERE id IN (SELECT account_id FROM calendars) " +
            "OR id IN (SELECT account_id FROM meetings) ORDER BY provider, external_id",
        )
        .all()
        .map(accountOf),
    meetingRows: async (filter) => {
      if (!Number.isInteger(filter.limit) || filter.limit < 1 || !Number.isInteger(filter.offset) || filter.offset < 0)
        invalid("limit takes 1 or more and offset 0 or more")
      return read(database, () => {
        const rows = rowsOf(context, filter)
        const filters = filtersOf(database, filter)
        const order = filter.newest === false ? "r.starts_at, r.type, r.id" : "r.starts_at DESC, r.type DESC, r.id DESC"
        const columns = `r.type, r.id, r.title, ${ROW_MEETINGS} AS meetings`
        const select = `${rows.sql} SELECT ${columns} FROM r ${filters.sql}`
        const words = (filter.titleWords ?? []).map(fold).filter((word) => word !== "")
        if (words.length > 0) {
          // SQLite's lower() folds ASCII only, so titles are compared folded here, as note search does.
          const matched = database
            .prepare(`${select} ORDER BY ${order}`)
            .all(...rows.params, ...filters.params)
            .filter((row) => {
              const title = fold(str(row.title) ?? "")
              return words.every((word) => title.includes(word))
            })
          return {
            items: hydrate(database, matched.slice(filter.offset, filter.offset + filter.limit).map(pageOf)),
            total: matched.length,
          }
        }
        const total = Number(
          database
            .prepare(`${rows.sql} SELECT count(*) AS n FROM r ${filters.sql}`)
            .get(...rows.params, ...filters.params)?.n,
        )
        const found = database
          .prepare(`${select} ORDER BY ${order} LIMIT ? OFFSET ?`)
          .all(...rows.params, ...filters.params, filter.limit, filter.offset)
        return { items: hydrate(database, found.map(pageOf)), total }
      })
    },
    meetingRow: async (target) =>
      read(database, () => {
        const meeting =
          "meeting" in target
            ? database
                .prepare(`SELECT m.id, ${HOME} AS home FROM meetings m WHERE m.id = ? AND m.deleted_at IS NULL`)
                .get(target.meeting)
            : undefined
        if ("meeting" in target && !meeting) return undefined
        const eventId = "event" in target ? target.event : num(meeting?.home)
        if (eventId === null) {
          const id = Number(meeting?.id)
          return hydrate(database, [{ type: "meeting", id, meetingIds: [id] }])[0]
        }
        const event = database.prepare("SELECT * FROM events WHERE id = ? AND deleted_at IS NULL").get(eventId)
        if (!event) return undefined
        const at = num(event.starts_at)
        // Its own meetings are found as a list finds them: by their homes, around its time.
        const filter: MeetingListFilter =
          at === null ? { limit: 1, offset: 0 } : { from: at - 1, to: at + 1, limit: 1, offset: 0 }
        const rows = rowsOf(context, filter)
        const found = database
          .prepare(
            `${rows.sql} SELECT r.type, r.id, ${ROW_MEETINGS} AS meetings FROM r WHERE r.type = 'event' AND r.id = ?`,
          )
          .get(...rows.params, eventId)
        const page: Page = found ? pageOf(found) : { type: "event", id: eventId, meetingIds: [] }
        return hydrate(database, [page])[0]
      }),
  }
}
