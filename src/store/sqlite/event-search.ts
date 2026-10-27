import type { Event } from "../../meetings/index.js"
import { QUERY_LIMITS } from "../../search/lucene/types.js"
import type { SqlValue } from "../driver.js"
import { eventOf } from "./events.js"
import {
  CORPORA,
  corpusIndexState,
  drainCorpus,
  EVENT_LIVE,
  EVENT_TEXT,
  type NoteIndexState,
  noteIndexText,
  searchableCopy,
} from "./note-index.js"
import { type Corpus, type CorpusQuery, searchCorpus } from "./note-search.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { read } from "./transaction.js"
import { dot } from "./vectors.js"

/** The fields an event has; a message or note field is refused rather than matching nothing. */
export const EVENT_FIELDS = ["text", "exact", "body", "title", "date", "in"] as const

/**
 * Whether the event `event` (an SQL expression of its id) has a searchable copy in the accounts of the one parameter,
 * a JSON list of stored account ids. Words and meaning both filter by it, so an event held in several accounts is
 * found through each of them.
 */
const inEventAccounts = (event: string) =>
  searchableCopy(event, "c.account_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))")

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
    sql: inEventAccounts("n.id"),
    params: [ids],
    exact: true,
  }),
}

/**
 * `accountIds` are stored account ids; `limit` and `offset` count hits, one per series. `candidates` is how many
 * matching events are read before they are grouped (50,000 by default).
 */
export type EventQuery = CorpusQuery & { candidates?: number }

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

export interface EventChunkToEmbed {
  hash: string
  text: string
}

export interface NearestEvent extends Omit<EventHit, "relevance" | "exact"> {
  /** Cosine of the best piece of its series; higher is nearer. */
  score: number
}

export interface EventSearch {
  /** Indexes what was written since, then searches: the occurrences of one series are one hit. */
  search(query: EventQuery): Promise<{
    items: EventHit[]
    hasMore: boolean
    /** More events matched than `candidates`: the ones past it were not read, so the last page may not be the end. */
    truncated: boolean
  }>
  eventIndexState(): Promise<NoteIndexState>
  /** Live events' pieces with no vector of `model`, by hash from `after`, each with its text cut again. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<EventChunkToEmbed[]>
  /** Whether any live event with a searchable copy in these accounts has a vector of `model`. */
  embedded(model: string, options?: { accountIds?: string[] }): Promise<boolean>
  /** Events nearest in meaning to `query`, one hit per series, best first. Vectors are unit length. */
  nearest(
    model: string,
    query: Float32Array,
    options: { limit: number; accountIds?: string[] },
  ): Promise<NearestEvent[]>
}

type Row = Record<string, unknown>

const SCAN_PAGE = 5_000

export const eventSearchOver = (context: StoreContext): EventSearch => {
  const { database } = context
  const stemmerFor = stemmerCache()
  const drain = () => drainCorpus(database, CORPORA.event, stemmerFor)

  /** The live event pieces with a searchable copy in these accounts, as SQL over chunks `k`. */
  const live = (accountIds: string[] | undefined) => {
    const sql = ` AND k.chunkable_type = 'event' AND EXISTS (SELECT 1 FROM events e WHERE e.id = k.chunkable_id AND ${EVENT_LIVE})`
    return accountIds?.length
      ? { sql: `${sql} AND ${inEventAccounts("k.chunkable_id")}`, params: [JSON.stringify(accountIds)] as SqlValue[] }
      : { sql, params: [] as SqlValue[] }
  }

  /** Events in rank order, as hits: one per series, at its occurrence nearest now that is not cancelled. */
  const grouped = <T extends { id: number }>(rows: T[], accountIds: string[] | undefined) => {
    const facts = new Map(
      database
        .prepare(
          "SELECT id, event_series_id AS series, starts_at, status FROM events WHERE id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(rows.map(({ id }) => id)))
        .map((row) => [Number(row.id), row]),
    )
    const groups = new Map<string, { first: T; members: Row[] }>()
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
        "WHERE ce.event_id = ? " +
        "ORDER BY c.account_id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?)), ce.deleted_at IS NOT NULL, ce.id LIMIT 1",
    )
    const chosen = JSON.stringify(accountIds ?? [])
    return [...groups.values()].map(({ first, members }) => {
      const id = Number(nearest(members).id)
      const row = event.get(id) as Row
      const at = place.get(id, chosen)
      return {
        first,
        hit: {
          ref: `event:${id}`,
          event: eventOf(row),
          text: String(row.text ?? ""),
          occurrences: members.length,
          account: at ? { provider: String(at.provider), account: String(at.account) } : null,
          url: at?.url == null ? null : String(at.url),
        },
      }
    })
  }

  return {
    search: async (query) => {
      drain()
      const offset = query.offset ?? 0
      const candidates = query.candidates ?? QUERY_LIMITS.candidates
      const matched = searchCorpus(context, { ...query, limit: candidates, offset: 0 }, EVENT_CORPUS)
      const truncated = matched.length > candidates
      const rows = truncated ? matched.slice(0, candidates) : matched
      return read(database, () => {
        const groups = grouped(rows, query.accountIds)
        return {
          items: groups.slice(offset, offset + query.limit).map(({ first, hit }) => ({
            ...hit,
            relevance: first.relevance,
            ...(first.exact === undefined ? {} : { exact: first.exact }),
          })),
          hasMore: groups.length > offset + query.limit,
          truncated,
        }
      })
    },
    eventIndexState: async () => corpusIndexState(database, CORPORA.event),
    chunksToEmbed: async (model, { after, limit }) => {
      drain()
      const scope = live(undefined)
      const text = database.prepare(`SELECT e.title, ${EVENT_TEXT} AS body FROM events e WHERE e.id = ?`)
      return database
        .prepare(
          `SELECT k.content_hash AS hash, min(k.chunkable_id) AS owner, k.start_offset AS start, k.end_offset AS end
             FROM chunks k
            WHERE k.content_hash > ?${scope.sql}
              AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)
            GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
        )
        .all(after ?? "", ...scope.params, model, limit)
        .flatMap((row) => {
          const event = text.get(Number(row.owner))
          if (!event) return []
          const whole = noteIndexText(event.title == null ? null : String(event.title), String(event.body))
          return [{ hash: String(row.hash), text: whole.slice(Number(row.start), Number(row.end)) }]
        })
    },
    embedded: async (model, { accountIds } = {}) => {
      drain()
      const scope = live(accountIds)
      return (
        database
          .prepare(
            `SELECT 1 FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
              WHERE 1 = 1${scope.sql} LIMIT 1`,
          )
          .get(model, ...scope.params) !== undefined
      )
    },
    nearest: async (model, query, { limit, accountIds }) => {
      drain()
      const scope = live(accountIds)
      const page = database.prepare(
        `SELECT k.id, k.chunkable_id AS owner, v.vector
           FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
          WHERE k.id > ?${scope.sql}
          ORDER BY k.id LIMIT ?`,
      )
      const best = new Map<number, number>()
      let after = 0
      for (;;) {
        const rows = page.all(model, after, ...scope.params, SCAN_PAGE)
        for (const row of rows) {
          const score = dot(query, row.vector as Uint8Array)
          const owner = Number(row.owner)
          if (score > (best.get(owner) ?? Number.NEGATIVE_INFINITY)) best.set(owner, score)
        }
        const last = rows.at(-1)
        if (!last || rows.length < SCAN_PAGE) break
        after = Number(last.id)
      }
      const ranked = [...best.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
      return read(database, () =>
        grouped(ranked, accountIds)
          .slice(0, limit)
          .map(({ first, hit }) => ({ ...hit, score: first.score })),
      )
    },
  }
}
