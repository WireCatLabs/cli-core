import type { CacheDatabase } from "../driver.js"
import { linkKind } from "./link-kinds.js"
import { referenceOfThing, stateOfThing, storedThing, type Thing, thingOf } from "./things.js"

/** One reference a memory or fact rests on, read back whole enough to judge it without opening it. */
export interface EvidenceSource {
  /** `null` when the row is gone from the store and its reference with it. */
  ref: string | null
  kind: string
  title: string | null
  sender: string | null
  at: string | null
  excerpt: string | null
  /** The provider the source came through: `telegram`, `email`, `notes`, `zoom`… */
  tool: string | null
  /** Deleted at its source since it was cited, or no longer in the store. */
  missing: boolean
}

const EXCERPT_CHARS = 280

const excerptOf = (text: unknown): string | null => {
  if (text == null) return null
  const flat = String(text).replace(/\s+/g, " ").trim()
  if (!flat) return null
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat
}

const iso = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())
const textOf = (value: unknown) => (value == null || String(value).trim() === "" ? null : String(value))

const READS: Partial<Record<Thing["type"], string>> = {
  message:
    "SELECT c.title, coalesce(m.sender_name, i.name) AS sender, m.sent_at AS at, m.text AS body, a.provider AS tool " +
    "FROM messages m JOIN chats c ON c.id = m.chat_id JOIN accounts a ON a.id = c.account_id " +
    "LEFT JOIN identities i ON i.id = m.sender_identity_id WHERE m.id = ?",
  email:
    "SELECT e.subject AS title, coalesce(e.from_name, e.from_address) AS sender, e.sent_at AS at, " +
    "coalesce(e.body_text, e.snippet) AS body, 'email' AS tool FROM emails e WHERE e.id = ?",
  note: "SELECT title, NULL AS sender, updated_at AS at, body, 'notes' AS tool FROM notes WHERE id = ?",
  document:
    "SELECT d.title, NULL AS sender, coalesce(d.external_updated_at, d.updated_at) AS at, d.body, a.provider AS tool " +
    "FROM documents d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?",
  meeting:
    "SELECT m.title, NULL AS sender, m.started_at AS at, m.description AS body, a.provider AS tool " +
    "FROM meetings m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?",
  meeting_transcript:
    "SELECT m.title, NULL AS sender, m.started_at AS at, NULL AS body, a.provider AS tool FROM meeting_transcripts t " +
    "JOIN meetings m ON m.id = t.meeting_id JOIN accounts a ON a.id = m.account_id WHERE t.id = ?",
  meeting_transcript_row:
    "SELECT m.title, r.speaker_name AS sender, m.started_at + coalesce(r.start_ms, 0) AS at, r.text AS body, " +
    "a.provider AS tool FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id = r.meeting_transcript_id " +
    "JOIN meetings m ON m.id = t.meeting_id JOIN accounts a ON a.id = m.account_id WHERE r.id = ?",
}

const KIND: Partial<Record<Thing["type"], string>> = {
  meeting_transcript: "meeting",
  meeting_transcript_row: "meeting",
}

const sourceOf = (database: CacheDatabase, thing: Thing): EvidenceSource => {
  const state = stateOfThing(database, thing)
  const read = READS[thing.type]
  const row = read === undefined || state === "unavailable" ? undefined : database.prepare(read).get(thing.id)
  const gone = state !== "available"
  return {
    ref: referenceOfThing(database, thing) ?? null,
    kind: KIND[thing.type] ?? thing.type,
    title: textOf(row?.title),
    sender: textOf(row?.sender),
    at: iso(row?.at),
    excerpt: gone ? null : excerptOf(row?.body),
    tool: textOf(row?.tool),
    missing: gone,
  }
}

/**
 * Every `evidence` link from a memory or fact, in the order they were written, including one whose target was
 * deleted since: `evidenceOf` drops those, so a reader would never learn the record lost a source.
 */
export const evidenceSourcesOf = (database: CacheDatabase, from: { type: string; id: number }): EvidenceSource[] =>
  database
    .prepare(
      `SELECT to_type, to_id FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("evidence")} ` +
        "AND to_id IS NOT NULL ORDER BY id",
    )
    .all(from.type, from.id)
    .map((link) => sourceOf(database, storedThing(link.to_type, link.to_id)))

const thingNamed = (database: CacheDatabase, reference: string): Thing | undefined => {
  try {
    return thingOf(database, reference)
  } catch {
    return undefined
  }
}

/** Each distinct reference read back, in order; one the store no longer resolves keeps its reference, `missing`. */
export const sourcesOfReferences = (database: CacheDatabase, references: readonly string[]): EvidenceSource[] =>
  [...new Set(references)].map((reference) => {
    const thing = thingNamed(database, reference)
    if (thing) return { ...sourceOf(database, thing), ref: reference }
    return {
      ref: reference,
      kind: reference.startsWith("msg:") ? "message" : reference.split(":")[0] || "unknown",
      title: null,
      sender: null,
      at: null,
      excerpt: null,
      tool: null,
      missing: true,
    }
  })
