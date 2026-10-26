import type { Event } from "../../meetings/index.js"
import { QUERY_LIMITS } from "../../search/lucene/types.js"
import { eventOf } from "./events.js"
import { CORPORA, corpusIndexState, drainCorpus, EVENT_LIVE, EVENT_TEXT, type NoteIndexState } from "./note-index.js"
import { type Corpus, type CorpusQuery, searchCorpus } from "./note-search.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { read } from "./transaction.js"

/** The fields an event has; a message or note field is refused rather than matching nothing. */
export const EVENT_FIELDS = ["text", "exact", "body", "title", "date", "in"] as const

const EVENT_CORPUS: Corpus = {
  type: "event",
  noun: "event",
  fields: EVENT_FIELDS,
  view:
    `(SELECT e.id, NULL AS folder_id, NULL AS path, e.title, ${EVENT_TEXT} AS text, NULL AS metadata, ` +
    `e.starts_at AS at, e.deleted_at, ${EVENT_LIVE} AS live FROM events e)`,
  words: "event_words",
  stems: "event_stems",
  live: "n.live = 1",
  inAccounts: (ids) => ({
    sql:
      "EXISTS (SELECT 1 FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id WHERE ce.event_id = n.id " +
      "AND ce.deleted_at IS NULL AND c.account_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))",
    params: [ids],
    exact: true,
  }),
}

/** `accountIds` are stored account ids; `limit` and `offset` count hits, one per series. */
export type EventQuery = CorpusQuery

export interface EventHit {
  /** `event:<id>`, of the occurrence shown. */
  ref: string
  /** The occurrence shown: of a series' matches, the one nearest now that is not cancelled. */
  event: Event
  /** What the words were matched in besides the title: description, place, attendees. */
  text: string
  /** bm25 of the words or stems; lower is better. `null` when ranked by time. */
  relevance: number | null
  exact?: boolean
  /** How many occurrences of its series matched; 1 for an event that does not repeat. */
  occurrences: number
  /** The calendar account it is in, the first of several; `null` for an event no calendar holds (a Zoom one). */
  account: { provider: string; account: string } | null
  /** The event's page at the calendar. */
  url: string | null
}

export interface EventSearch {
  /** Indexes what was written since, then searches: the occurrences of one series are one hit. */
  search(query: EventQuery): Promise<{ items: EventHit[]; hasMore: boolean }>
  eventIndexState(): Promise<NoteIndexState>
}

type Row = Record<string, unknown>

export const eventSearchOver = (context: StoreContext): EventSearch => {
  const { database } = context
  const stemmerFor = stemmerCache()
  return {
    search: async (query) => {
      drainCorpus(database, CORPORA.event, stemmerFor)
      const offset = query.offset ?? 0
      const rows = searchCorpus(context, { ...query, limit: QUERY_LIMITS.candidates, offset: 0 }, EVENT_CORPUS)
      return read(database, () => {
        const facts = new Map(
          database
            .prepare(
              "SELECT id, event_series_id AS series, starts_at, status FROM events WHERE id IN (SELECT value FROM json_each(?))",
            )
            .all(JSON.stringify(rows.map(({ id }) => id)))
            .map((row) => [Number(row.id), row]),
        )
        const groups = new Map<string, { first: (typeof rows)[number]; members: Row[] }>()
        for (const row of rows) {
          const fact = facts.get(row.id)
          if (!fact) continue
          const key = fact.series == null ? `e${row.id}` : `s${fact.series}`
          const group = groups.get(key) ?? { first: row, members: [] }
          group.members.push(fact)
          groups.set(key, group)
        }
        const now = context.now()
        const nearest = (members: Row[]) =>
          members.toSorted(
            (a, b) =>
              Number(a.status === "cancelled") - Number(b.status === "cancelled") ||
              Math.abs(Number(a.starts_at ?? 0) - now) - Math.abs(Number(b.starts_at ?? 0) - now) ||
              Number(a.id) - Number(b.id),
          )[0] as Row
        const event = database.prepare(`SELECT e.*, ${EVENT_TEXT} AS text FROM events e WHERE e.id = ?`)
        const place = database.prepare(
          "SELECT a.provider, a.external_id AS account, ce.url FROM calendar_entries ce " +
            "JOIN calendars c ON c.id = ce.calendar_id JOIN accounts a ON a.id = c.account_id " +
            "WHERE ce.event_id = ? AND ce.deleted_at IS NULL " +
            "ORDER BY c.account_id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?)), ce.id LIMIT 1",
        )
        const chosen = JSON.stringify(query.accountIds ?? [])
        const page = [...groups.values()].slice(offset, offset + query.limit)
        return {
          items: page.map(({ first, members }) => {
            const id = Number(nearest(members).id)
            const row = event.get(id) as Row
            const at = place.get(id, chosen)
            return {
              ref: `event:${id}`,
              event: eventOf(row),
              text: String(row.text ?? ""),
              relevance: first.relevance,
              ...(first.exact === undefined ? {} : { exact: first.exact }),
              occurrences: members.length,
              account: at ? { provider: String(at.provider), account: String(at.account) } : null,
              url: at?.url == null ? null : String(at.url),
            }
          }),
          hasMore: groups.size > offset + query.limit || rows.length > QUERY_LIMITS.candidates,
        }
      })
    },
    eventIndexState: async () => corpusIndexState(database, CORPORA.event),
  }
}
