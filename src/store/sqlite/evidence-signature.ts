import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { ENTITY_TABLES, isEntityType } from "./entity-types.js"
import { referenceOfThing, storedThing, type Thing } from "./things.js"

/**
 * What a cited source looks like now, read from its columns only, never its text. `sig` differs whenever the source
 * changed or was deleted in a way this store can see. `rev` finds a version later: for a note or a document its
 * `revision`, whose older body `*_revisions` keeps under that number; for a message or a calendar event the highest id
 * in its `*_revisions` table at the time (`0` for none), so that version's text is the first revision above it, or the
 * current text when there is none; `null` where the store keeps no history.
 */
export interface EvidenceSignature {
  sig: string
  rev: number | null
  /** Deleted at its source, or the row is gone from the store. */
  deleted: boolean
  /** The latest change or deletion the store dated; `null` when it dates none, or the row is gone. */
  changedAt: number | null
}

/** What `links.metadata` holds on an `evidence` row. */
export interface EvidenceMetadata {
  v: 1
  sig: string
  /** The version last signed. */
  rev: number | null
  /** The version cited; it never changes after the link is written. */
  cited_rev: number | null
  quote?: string
  checked_at: number
  /** The cited row was deleted for good: the link keeps no pointer, only the kind it named. */
  gone?: string
}

/** A cited reference, with the words of it the claim rests on. */
export type EvidenceInput = string | { ref: string; quote?: string }

export const QUOTE_LIMIT = 500

/** How one kind of source is signed, searched for a quote, and read back as it was cited. */
interface SourceKind {
  signature(database: CacheDatabase, id: number): EvidenceSignature | undefined
  /** Whether the text holds the quote now; absent where the store keeps no text for the kind. */
  holds?(database: CacheDatabase, id: number, quote: string): boolean
  /** The text at version `rev`; absent where the store keeps no history for the kind. */
  textAt?(database: CacheDatabase, id: number, rev: number): string | undefined
}

type Row = Record<string, unknown>

const GONE: EvidenceSignature = { sig: "gone", rev: null, deleted: true, changedAt: null }

const part = (value: unknown): string => (value == null ? "" : String(value))
const sigOf = (...values: unknown[]) => values.map(part).join("|")
const latest = (...times: unknown[]): number | null => {
  let last: number | null = null
  for (const time of times) if (time != null && (last === null || Number(time) > last)) last = Number(time)
  return last
}

const folded = (text: string) =>
  text
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()

/**
 * The quote still stands in the text word for word, whatever the spacing and line breaks. Case and accents count:
 * the search normalizer folds them, and a changed letter here may be the change that matters.
 */
export const quoteKept = (quote: string, text: string): boolean => {
  const wanted = folded(quote)
  return wanted.length > 0 && folded(text).includes(wanted)
}

const textOf = (database: CacheDatabase, sql: string, ...values: SqlValue[]): string | undefined => {
  const row = database.prepare(sql).get(...values)
  return row?.text == null ? undefined : String(row.text)
}

const holdsIn =
  (sql: string) =>
  (database: CacheDatabase, id: number, quote: string): boolean =>
    quoteKept(quote, textOf(database, sql, id) ?? "")

const revised = (table: string, owner: string) => `(SELECT max(created_at) FROM ${table} WHERE ${owner} = t.id)`

/** A note or a document: `created_at` is in the signature so a new row that takes a deleted one's id never matches. */
const versioned = (table: "notes" | "documents", revisions: string, owner: string): SourceKind => ({
  signature: (database, id) => {
    const hash = table === "documents" ? "t.content_hash" : "NULL"
    const row = database
      .prepare(
        `SELECT ${hash} AS content_hash, t.revision, t.deleted_at, t.created_at, ${revised(revisions, owner)} AS revised ` +
          `FROM ${table} t WHERE t.id = ?`,
      )
      .get(id)
    return (
      row && {
        sig: sigOf(row.created_at, row.content_hash, row.revision, row.deleted_at),
        rev: Number(row.revision),
        deleted: row.deleted_at != null,
        changedAt: latest(row.revised, row.deleted_at),
      }
    )
  },
  holds: holdsIn(`SELECT body AS text FROM ${table} WHERE id = ?`),
  textAt: (database, id, rev) =>
    textOf(database, `SELECT body AS text FROM ${table} WHERE id = ? AND revision = ?`, id, rev) ??
    textOf(database, `SELECT body AS text FROM ${revisions} WHERE ${owner} = ? AND revision = ? ORDER BY id`, id, rev),
})

/** The revision counts too: a provider may resend changed text without an edit time, and the store still keeps one. */
const message: SourceKind = {
  signature: (database, id) => {
    const row = database
      .prepare(
        "SELECT t.edited_at, t.deleted_at, t.created_at, (SELECT max(id) FROM message_revisions WHERE message_id = t.id) " +
          `AS rev, ${revised("message_revisions", "message_id")} AS revised FROM messages t WHERE t.id = ?`,
      )
      .get(id)
    return (
      row && {
        sig: sigOf(row.created_at, row.edited_at, row.deleted_at, row.rev),
        rev: Number(row.rev ?? 0),
        deleted: row.deleted_at != null,
        changedAt: latest(row.revised, row.deleted_at),
      }
    )
  },
  holds: holdsIn("SELECT text FROM messages WHERE id = ?"),
  textAt: (database, id, rev) =>
    textOf(
      database,
      "SELECT text FROM message_revisions WHERE message_id = ? AND id > ? ORDER BY id LIMIT 1",
      id,
      rev,
    ) ?? textOf(database, "SELECT text FROM messages WHERE id = ?", id),
}

const transcriptSignature = (database: CacheDatabase, id: number): EvidenceSignature | undefined => {
  const row = database
    .prepare("SELECT content_hash, deleted_at, superseded_at, created_at FROM meeting_transcripts WHERE id = ?")
    .get(id)
  return (
    row && {
      sig: sigOf(row.created_at, row.content_hash, row.superseded_at, row.deleted_at),
      rev: null,
      deleted: row.deleted_at != null,
      changedAt: latest(row.deleted_at),
    }
  )
}

const TRANSCRIPT_PAGE = 200

/** Reads a transcript a page at a time, keeping only as much of the text before as a quote can span. */
const transcriptHolds = (database: CacheDatabase, id: number, quote: string): boolean => {
  const wanted = folded(quote)
  if (!wanted) return false
  const page = database.prepare(
    "SELECT position, text FROM meeting_transcript_rows WHERE meeting_transcript_id = ? AND position > ? " +
      "ORDER BY position LIMIT ?",
  )
  let tail = ""
  let after = -1
  for (;;) {
    const rows = page.all(id, after, TRANSCRIPT_PAGE) as Row[]
    for (const row of rows) {
      const text = `${tail} ${folded(String(row.text))}`.trim()
      if (text.includes(wanted)) return true
      tail = text.slice(-wanted.length)
      after = Number(row.position)
    }
    if (rows.length < TRANSCRIPT_PAGE) return false
  }
}

const transcript: SourceKind = { signature: transcriptSignature, holds: transcriptHolds }

const transcriptRow: SourceKind = {
  signature: (database, id) => {
    const row = database
      .prepare("SELECT meeting_transcript_id AS transcript, created_at FROM meeting_transcript_rows WHERE id = ?")
      .get(id)
    const whole = row && transcriptSignature(database, Number(row.transcript))
    return whole && { ...whole, sig: sigOf(row.created_at, whole.sig) }
  },
  holds: holdsIn("SELECT text FROM meeting_transcript_rows WHERE id = ?"),
}

/** A calendar citation names the event; what changes is each entry of it, whose older versions are its revisions. */
const event: SourceKind = {
  signature: (database, id) => {
    const row = database
      .prepare(
        "SELECT e.created_at, e.source_deleted_at, e.deleted_at, max(r.id) AS rev, max(r.created_at) AS revised " +
          "FROM events e LEFT JOIN calendar_entries c ON c.event_id = e.id " +
          "LEFT JOIN calendar_entry_revisions r ON r.entry_id = c.id WHERE e.id = ? GROUP BY e.id",
      )
      .get(id)
    return (
      row && {
        sig: sigOf(row.created_at, row.rev, row.source_deleted_at, row.deleted_at),
        rev: Number(row.rev ?? 0),
        deleted: row.source_deleted_at != null || row.deleted_at != null,
        changedAt: latest(row.revised, row.source_deleted_at, row.deleted_at),
      }
    )
  },
  holds: holdsIn(
    "SELECT coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(location, '') AS text " +
      "FROM events WHERE id = ?",
  ),
}

const status = (table: "facts" | "memories"): SourceKind => ({
  signature: (database, id) => {
    const row = database.prepare(`SELECT status, deleted_at, updated_at FROM ${table} WHERE id = ?`).get(id)
    return (
      row && {
        sig: sigOf(row.status, row.deleted_at),
        rev: null,
        deleted: row.deleted_at != null,
        changedAt: latest(row.updated_at),
      }
    )
  },
  holds: holdsIn(`SELECT ${table === "facts" ? "statement" : "body"} AS text FROM ${table} WHERE id = ?`),
})

const columnsOf = new WeakMap<CacheDatabase, Map<string, boolean>>()
const hasColumn = (database: CacheDatabase, table: string, column: string): boolean => {
  const known = columnsOf.get(database) ?? new Map<string, boolean>()
  columnsOf.set(database, known)
  const key = `${table}.${column}`
  if (!known.has(key))
    known.set(
      key,
      database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined,
    )
  return known.get(key) === true
}

const existence = (database: CacheDatabase, table: string, id: number): EvidenceSignature | undefined => {
  const deleted = hasColumn(database, table, "deleted_at") ? "deleted_at" : "NULL AS deleted_at"
  const created = hasColumn(database, table, "created_at") ? "created_at" : "NULL AS created_at"
  const row = database.prepare(`SELECT ${deleted}, ${created} FROM ${table} WHERE id = ?`).get(id)
  return (
    row && {
      sig: sigOf(row.created_at, row.deleted_at),
      rev: null,
      deleted: row.deleted_at != null,
      changedAt: latest(row.deleted_at),
    }
  )
}

const existing = (table: string): SourceKind => ({ signature: (database, id) => existence(database, table, id) })

/** A thing an import made from a source's record changes when the record does. */
const recorded = (type: string, table: string): SourceKind => ({
  signature: (database, id) => {
    const base = existence(database, table, id)
    if (!base) return undefined
    const records = database
      .prepare(
        "SELECT fingerprint, revision, deleted_at, updated_at FROM records WHERE entity_type = ? AND entity_id = ? ORDER BY id",
      )
      .all(type, id) as Row[]
    if (records.length === 0) return base
    return {
      sig: [base.sig, ...records.map((record) => sigOf(record.fingerprint, record.revision, record.deleted_at))].join(
        ";",
      ),
      rev: records[0]?.revision == null ? null : Number(records[0].revision),
      deleted: base.deleted || records.every((record) => record.deleted_at != null),
      changedAt: latest(base.changedAt, ...records.map((record) => record.updated_at)),
    }
  },
})

/**
 * Every kind of source a memory or fact may cite, by its `links.to_type`. An email, a meeting, a person and a project
 * are checked for existence only; any other row an import made from a record follows that record.
 */
export const SOURCE_KINDS: Partial<Record<string, SourceKind>> = {
  document: versioned("documents", "document_revisions", "document_id"),
  document_picture: versioned("documents", "document_revisions", "document_id"),
  note: versioned("notes", "note_revisions", "note_id"),
  message,
  meeting_transcript: transcript,
  meeting_transcript_row: transcriptRow,
  event,
  fact: status("facts"),
  memory: status("memories"),
  email: { ...existing("emails"), holds: holdsIn("SELECT body_text AS text FROM emails WHERE id = ?") },
  meeting: existing("meetings"),
  person: existing("persons"),
  project: existing("projects"),
}

export const sourceKindOf = (type: string): SourceKind | undefined =>
  SOURCE_KINDS[type] ?? (isEntityType(type) ? recorded(type, ENTITY_TABLES[type]) : undefined)

/** The signature of a cited row as it is now; a row the store no longer holds is `deleted`. */
export const evidenceSignature = (database: CacheDatabase, thing: Thing): EvidenceSignature =>
  sourceKindOf(thing.type)?.signature(database, thing.id) ?? GONE

/** Whether a cited row's text holds the quote now; `undefined` where the store keeps no text for its kind. */
export const sourceHolds = (database: CacheDatabase, thing: Thing, quote: string): boolean | undefined => {
  const holds = sourceKindOf(thing.type)?.holds
  return holds === undefined ? undefined : holds(database, thing.id, quote)
}

/** The text of a cited row at version `rev`, from its history; `undefined` where there is none. */
export const sourceTextAt = (database: CacheDatabase, thing: Thing, rev: number): string | undefined =>
  sourceKindOf(thing.type)?.textAt?.(database, thing.id, rev)

/** The reference and quote of one cited source, refusing a quote too long or empty. */
export const evidenceInputOf = (input: EvidenceInput): { ref: string; quote?: string } => {
  if (typeof input === "string") return { ref: input }
  if (input.quote === undefined) return { ref: input.ref }
  const quote = input.quote.trim()
  if (!quote || quote.length > QUOTE_LIMIT)
    throw new CliError("validation_error", `a quote from the evidence takes 1–${QUOTE_LIMIT} characters`, {
      reason: "evidence.quote-length",
    })
  return { ref: input.ref, quote }
}

/** Refuses a quote the cited source's text does not hold: a claim may rest only on words the source said. */
export const assertQuoted = (database: CacheDatabase, thing: Thing, ref: string, quote: string | undefined): void => {
  if (quote === undefined || sourceHolds(database, thing, quote) !== false) return
  throw new CliError("validation_error", `${ref} does not say "${quote.slice(0, 80)}"`, {
    reason: "evidence.quote-not-found",
  })
}

/** A new link's metadata: the version cited is the version signed. */
export const evidenceMetadata = (
  signature: EvidenceSignature,
  at: number,
  quote: string | undefined,
): EvidenceMetadata => ({
  v: 1,
  sig: signature.sig,
  rev: signature.rev,
  cited_rev: signature.rev,
  ...(quote === undefined ? {} : { quote }),
  checked_at: at,
})

/** The stored signature of an `evidence` link, or `undefined` for one written before signatures. */
export const storedEvidenceMetadata = (metadata: unknown): EvidenceMetadata | undefined => {
  if (typeof metadata !== "string") return undefined
  try {
    const parsed = JSON.parse(metadata) as Partial<EvidenceMetadata>
    if (parsed?.v !== 1 || typeof parsed.sig !== "string") return undefined
    return { ...parsed, cited_rev: parsed.cited_rev ?? parsed.rev ?? null } as EvidenceMetadata
  } catch {
    return undefined
  }
}

/**
 * Signs an `evidence` link again. It keeps the quote and the version cited, and the link's own `updated_at` stays, as
 * nothing about the link changed. A link written before signatures takes the version it is signed at as cited.
 */
export const resignEvidence = (
  database: CacheDatabase,
  link: number,
  signature: EvidenceSignature,
  at: number,
  previous: EvidenceMetadata | undefined,
): void => {
  const metadata: EvidenceMetadata = {
    ...evidenceMetadata(signature, at, previous?.quote),
    cited_rev: previous === undefined ? signature.rev : previous.cited_rev,
  }
  database.prepare("UPDATE links SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), link)
}

/** An evidence link whose source went, as `forgetEvidenceTo` left it. */
export interface ForgottenEvidence {
  link: number
  from: Thing
  /** The reference the link named before its source went. */
  ref: string | null
  citedRev: number | null
}

/**
 * Before cited rows go, or a message's text is erased: each evidence link to them drops its quote, which holds the
 * source's words. `ids` is SQL naming the row ids. A row deleted for good also loses its pointer, so the link still
 * says that a source was cited and is gone, and never names another row that takes the same id later; its old
 * reference stays only as `target_text`, which nothing resolves since `target_folded` is empty. A tombstone
 * (`keepPointer`) keeps it, signed as deleted.
 */
export const forgetEvidenceTo = (
  database: CacheDatabase,
  type: string,
  ids: { sql: string; params: SqlValue[] },
  at: number,
  { keepPointer = false }: { keepPointer?: boolean } = {},
): ForgottenEvidence[] => {
  const links = database
    .prepare(
      "SELECT id, from_type, from_id, to_type, to_id, metadata FROM links WHERE kind = 'evidence' AND to_type = ? " +
        `AND to_id IN (${ids.sql})`,
    )
    .all(type, ...ids.params) as Row[]
  const detach = database.prepare(
    "UPDATE links SET to_type = NULL, to_id = NULL, target_text = ?, target_folded = NULL, metadata = ? WHERE id = ?",
  )
  return links.map((link) => {
    const thing = storedThing(link.to_type, link.to_id)
    const previous = storedEvidenceMetadata(link.metadata)
    const ref = referenceOfThing(database, thing) ?? null
    const citedRev = previous?.cited_rev ?? null
    if (keepPointer) {
      const signature = evidenceSignature(database, thing)
      const metadata = { ...evidenceMetadata(signature, at, undefined), cited_rev: previous ? citedRev : signature.rev }
      database.prepare("UPDATE links SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), Number(link.id))
    } else {
      const metadata: EvidenceMetadata = {
        v: 1,
        sig: GONE.sig,
        rev: null,
        cited_rev: citedRev,
        checked_at: at,
        gone: type,
      }
      detach.run(ref ?? `${type}:${thing.id}`, JSON.stringify(metadata), Number(link.id))
    }
    return { link: Number(link.id), from: storedThing(link.from_type, link.from_id), ref, citedRev }
  })
}

/** `forgetEvidenceTo` for one row. */
export const forgetEvidenceToRow = (
  database: CacheDatabase,
  thing: Thing,
  at: number,
  options?: { keepPointer?: boolean },
) => forgetEvidenceTo(database, thing.type, { sql: "?", params: [thing.id] }, at, options)

/**
 * After a purge, in its write: forgets evidence still pointing at a row of any citable type that is no longer there,
 * so a kind the purge did not name is not missed. The purge names what it can beforehand, while references resolve.
 */
export const forgetDanglingEvidence = (database: CacheDatabase, at: number): ForgottenEvidence[] =>
  Object.entries(ENTITY_TABLES).flatMap(([type, table]) =>
    forgetEvidenceTo(
      database,
      type,
      {
        sql:
          "SELECT l.to_id FROM links l WHERE l.kind = 'evidence' AND l.to_type = ? AND l.to_id IS NOT NULL " +
          `AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = l.to_id)`,
        params: [type],
      },
      at,
    ),
  )

/** Deletes a document row after forgetting the evidence that cites it, so no link is left pointing at a reused id. */
export const deleteDocumentRow = (database: CacheDatabase, id: number, at: number): void => {
  forgetEvidenceToRow(database, { type: "document", id }, at)
  database.prepare("DELETE FROM documents WHERE id = ?").run(id)
}
