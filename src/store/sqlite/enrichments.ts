import { chunkHash } from "../../conversations/chunks.js"
import type { CacheDatabase } from "../driver.js"
import { noteIndexText } from "./index-text.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export type EnrichmentSubject = "document" | "note" | "email"

export const ENRICHMENT_SUBJECTS: readonly EnrichmentSubject[] = ["document", "note", "email"]

/**
 * A note's or document's enrichment chunk sits at this position under the record's own chunks, so a hit by meaning
 * still names the record. Its offsets are 0: its text is the enrichment's, never a stretch of the record's.
 */
export const ENRICHMENT_POSITION = 1_000_000

/** An email's enrichment chunk: thread pieces are cut again by position, so a reserved position there would break. */
export const EMAIL_ENRICHMENT = "email_enrichment"

export interface EnrichmentCandidate {
  type: EnrichmentSubject
  id: number
  /** The record's indexed text, title first: what the hash covers. */
  text: string
  at: number | null
  hash: string
}

export interface SavedEnrichment {
  type: EnrichmentSubject
  id: number
  hash: string
  provider: string
  model: string
  text: string
  tokens: number
}

export interface EnrichmentNarrowing {
  types?: readonly EnrichmentSubject[]
  only?: readonly { type: EnrichmentSubject; id: number }[]
}

export interface EnrichmentCounts {
  /** Live records search reads: documents, notes and emails. */
  records: number
  /** Of those, the ones whose current text has an enrichment. */
  enriched: number
  /** Characters of the records still to enrich, for a cost estimate. */
  pendingChars: number
}

export interface EnrichmentStore {
  /** Up to `limit` live records with no enrichment of their current text, by type then id; `only` narrows them. */
  pending(limit: number, narrow?: EnrichmentNarrowing): Promise<EnrichmentCandidate[]>
  counts(): Promise<EnrichmentCounts>
  /** Keeps each text and queues its record, so the next index drain adds it to the record's stems and chunks. */
  save(rows: readonly SavedEnrichment[]): Promise<void>
  /** Deletes every enrichment and queues its record: the drain then indexes the record's own text alone. */
  clear(): Promise<number>
}

const LIVE: Record<EnrichmentSubject, string> = {
  document:
    "SELECT d.id, d.title, coalesce(d.body, '') AS body, coalesce(d.external_updated_at, d.updated_at) AS at FROM documents d " +
    "WHERE d.deleted_at IS NULL AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1) = 1",
  note: "SELECT n.id, n.title, coalesce(n.body, '') AS body, n.updated_at AS at FROM notes n WHERE n.deleted_at IS NULL",
  email:
    "SELECT e.id, e.subject AS title, coalesce(e.body_text, '') AS body, coalesce(e.sent_at, e.received_at) AS at " +
    "FROM emails e WHERE e.deleted_at IS NULL",
}

const QUEUES: Record<EnrichmentSubject, string> = {
  document: "INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', ?)",
  note: "INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', ?)",
  email: "INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', ?)",
}

/** The hash an enrichment is kept under: of the text the corpus indexes, so an edit makes it stale. */
export const enrichmentHash = (title: string | null, body: string): string => chunkHash(noteIndexText(title, body))

/** The record's enrichment text when it was written for its current text; a stale one is never indexed. */
export const currentEnrichment = (
  database: CacheDatabase,
  type: string,
  id: number,
  indexed: string,
): string | undefined => {
  if (!(ENRICHMENT_SUBJECTS as readonly string[]).includes(type)) return undefined
  const row = database
    .prepare("SELECT text, source_hash FROM enrichments WHERE subject_type = ? AND subject_id = ?")
    .get(type, id)
  return row && String(row.source_hash) === chunkHash(indexed) ? String(row.text) : undefined
}

/** An enrichment's text by its chunk's owner, for the embed pass. */
export const enrichmentText = (database: CacheDatabase, type: string, id: number): string | undefined => {
  const row = database
    .prepare("SELECT text FROM enrichments WHERE subject_type = ? AND subject_id = ?")
    .get(type === EMAIL_ENRICHMENT ? "email" : type, id)
  return row === undefined ? undefined : String(row.text)
}

const scan = function* (database: CacheDatabase, type: EnrichmentSubject, only?: ReadonlySet<number>) {
  const held = new Map(
    database
      .prepare("SELECT subject_id AS id, source_hash AS hash FROM enrichments WHERE subject_type = ?")
      .all(type)
      .map((row) => [Number(row.id), String(row.hash)]),
  )
  for (const row of database.prepare(`${LIVE[type]} ORDER BY 1`).all()) {
    const id = Number(row.id)
    if (only && !only.has(id)) continue
    const title = row.title == null ? null : String(row.title)
    const text = noteIndexText(title, String(row.body))
    if (!text.trim()) continue
    const hash = chunkHash(text)
    yield { type, id, text, at: row.at == null ? null : Number(row.at), hash, enriched: held.get(id) === hash }
  }
}

export const enrichmentsOver = ({ database, now }: StoreContext): EnrichmentStore => ({
  pending: async (limit, { types = ENRICHMENT_SUBJECTS, only } = {}) => {
    const found: EnrichmentCandidate[] = []
    for (const type of types) {
      const ids = only ? new Set(only.filter((one) => one.type === type).map((one) => one.id)) : undefined
      if (ids?.size === 0) continue
      for (const { enriched, ...candidate } of scan(database, type, ids)) {
        if (found.length >= limit) return found
        if (!enriched) found.push(candidate)
      }
    }
    return found
  },
  counts: async () => {
    const counts: EnrichmentCounts = { records: 0, enriched: 0, pendingChars: 0 }
    for (const type of ENRICHMENT_SUBJECTS)
      for (const one of scan(database, type)) {
        counts.records += 1
        if (one.enriched) counts.enriched += 1
        else counts.pendingChars += one.text.length
      }
    return counts
  },
  save: async (rows) =>
    write(database, () => {
      const upsert = database.prepare(
        `INSERT INTO enrichments (subject_type, subject_id, source_hash, provider, model, text, tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (subject_type, subject_id) DO UPDATE SET source_hash = excluded.source_hash,
             provider = excluded.provider, model = excluded.model, text = excluded.text, tokens = excluded.tokens,
             created_at = excluded.created_at`,
      )
      const at = now()
      for (const row of rows) {
        upsert.run(row.type, row.id, row.hash, row.provider, row.model, row.text, row.tokens, at)
        database.prepare(QUEUES[row.type]).run(row.id)
      }
    }),
  clear: async () =>
    write(database, () => {
      const rows = database.prepare("SELECT subject_type AS type, subject_id AS id FROM enrichments").all()
      for (const row of rows) database.prepare(QUEUES[row.type as EnrichmentSubject]).run(Number(row.id))
      database.prepare("DELETE FROM enrichments").run()
      return rows.length
    }),
})
