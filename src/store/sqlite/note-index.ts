import { CliError } from "@wirecat/cli-base"
import { CHUNK_CHARS, chunkHash, splitSections, splitText } from "../../conversations/chunks.js"
import type { EntryEventType } from "../../meetings/index.js"
import { analyzerIdentity, DEFAULT_STEMMERS, type Stemmer, type Stemmers } from "../../search/stem.js"
import { taskStemsOf, taskWordsOf } from "../../search/task-similarity.js"
import type { CacheDatabase } from "../driver.js"
import { normalize } from "../normalize.js"
import { dropDocumentPicture } from "./document-pictures.js"
import { int } from "./events.js"
import { indexRow } from "./index-state.js"
import { speech } from "./lucene-fields.js"
import type { Where } from "./query-filter.js"
import { savedStemmers } from "./stems.js"
import { write } from "./transaction.js"
import { dropUnusedVectors } from "./vector-index.js"

export interface NoteIndexState {
  /** Rows written since they were indexed. */
  pending: number
  /** The stemmer choices the stems were built by; `null` until the first drain. */
  built: string | null
  wanted: string | null
  /** Every live row is in the words, stems and chunks: a search sees all of them. */
  ready: boolean
}

/**
 * A text corpus with its own words and stems index, filled from its queue: documents, notes and memories
 * share the recipe, each with its own tables.
 */
export interface Corpus {
  /** The singular table name: `indexable_type` in the queue, `chunkable_type` in chunks. */
  type: "document" | "note" | "memory" | "email" | "task" | "transcript" | "event"
  /** Its row in `search_index_state`. */
  index: string
  table: string
  /** Title and body as `title`/`body`, whether it is live, and its scope, for one row by `id`. */
  read: string
  /** `indexable_type` in the queue when it is not `type`: the table a queued id points into. */
  queued?: "attachment"
  /** False when the corpus cuts its own pieces for search by meaning, as mail does by thread. */
  pieces?: false
  /** The words and stems rows, when the corpus cleans its text its own way; `normalize` and `indexText` otherwise. */
  terms?: (text: string, stemmer: Stemmer) => { words: string; stems: string }
}

/** What an event `e` is searched by besides its title: the cleaned description, the place and the attendees' names. */
export const EVENT_TEXT =
  "trim(coalesce(e.description, '') || ' ' || coalesce(e.location, '') || ' ' || coalesce((" +
  "SELECT group_concat(p.name, ' ') FROM calendar_entries ce JOIN calendar_entry_participants p ON p.entry_id = ce.id " +
  "WHERE ce.event_id = e.id AND ce.deleted_at IS NULL AND p.resource = 0 AND p.name IS NOT NULL), ''))"

/** Calendar entry types that are listed, never searched (requirements 3.4). */
export const UNSEARCHED_EVENT_TYPES = [
  "working-location",
  "focus",
  "out-of-office",
  "birthday",
] as const satisfies readonly EntryEventType[]

/** Visibilities whose entry, when it carries no text, is a busy-only slot: stored, never searched (requirements 3.4). */
export const BUSY_ONLY_VISIBILITIES = ["private", "confidential"] as const

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ")

/** A calendar copy `ce` that may be searched: of a searchable type, and not a busy-only slot. */
const SEARCHABLE_COPY =
  `(ce.event_type IS NULL OR ce.event_type NOT IN (${sqlList(UNSEARCHED_EVENT_TYPES)})) ` +
  `AND NOT (coalesce(ce.visibility, '') IN (${sqlList(BUSY_ONLY_VISIBILITIES)}) AND trim(coalesce(ce.title, '')) = '' ` +
  "AND trim(coalesce(ce.description, '')) = '' AND trim(coalesce(ce.location, '')) = '')"

/**
 * Whether the event `event` (an SQL expression of its id) has a searchable calendar copy, and with `account` one in
 * those accounts (an SQL condition over `c.account_id`). Only live copies count, unless none is: an event its
 * calendars deleted keeps its past copies as history.
 */
export const searchableCopy = (event: string, account?: string): string =>
  `EXISTS (SELECT 1 FROM calendar_entries ce${account ? " JOIN calendars c ON c.id = ce.calendar_id" : ""} ` +
  `WHERE ce.event_id = ${event} AND ${SEARCHABLE_COPY}${account ? ` AND ${account}` : ""} ` +
  `AND (ce.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM calendar_entries l WHERE l.event_id = ${event} ` +
  "AND l.deleted_at IS NULL)))"

/**
 * Whether an event `e` is searched at all: by words, by meaning and in `search all`. The one place that names what
 * is left out. An event no calendar holds (a Zoom meeting's own) is searched; a cancelled one is not.
 */
export const EVENT_LIVE =
  "(e.deleted_at IS NULL AND coalesce(e.status, '') <> 'cancelled' AND " +
  `(NOT EXISTS (SELECT 1 FROM calendar_entries ce WHERE ce.event_id = e.id) OR ${searchableCopy("e.id")}))`

export const CORPORA = {
  document: {
    type: "document",
    index: "document_index",
    table: "documents",
    read:
      "SELECT d.title, coalesce(d.body, '') AS body, d.metadata, d.deleted_at IS NULL AS live, a.scope, d.account_id FROM documents d " +
      "JOIN accounts a ON a.id = d.account_id WHERE d.id = ?",
  },
  note: {
    type: "note",
    index: "note_index",
    table: "notes",
    read: "SELECT title, body, deleted_at IS NULL AS live, 'personal' AS scope FROM notes WHERE id = ?",
  },
  memory: {
    type: "memory",
    index: "memory_index",
    table: "memories",
    read: "SELECT NULL AS title, body, status <> 'superseded' AS live, scope FROM memories WHERE id = ?",
  },
  email: {
    type: "email",
    index: "email_index",
    table: "emails",
    read:
      "SELECT e.subject AS title, coalesce(e.body_text, '') AS body, e.deleted_at IS NULL AS live, a.scope, e.account_id FROM emails e " +
      "JOIN accounts a ON a.id = e.account_id WHERE e.id = ?",
    pieces: false,
  },
  task: {
    type: "task",
    index: "task_index",
    table: "tasks",
    // A rule names its task `<kind> — <source>`: words every rule task shares, so they say nothing about this one.
    read:
      "SELECT CASE WHEN title = type || ' — ' || coalesce(source_locator, '') THEN NULL ELSE title END AS title, " +
      "coalesce(description, '') AS body, deleted_at IS NULL AS live, 'personal' AS scope FROM tasks WHERE id = ?",
    pieces: false,
    terms: (text, stemmer) => ({ words: taskWordsOf(text), stems: [...taskStemsOf(text, stemmer)].join(" ") }),
  },
  transcript: {
    type: "transcript",
    queued: "attachment",
    index: "transcript_index",
    table: `(SELECT a.id FROM attachments a WHERE a.attachable_type = 'message' AND ${speech("a")})`,
    read:
      `SELECT NULL AS title, coalesce(a.text, '') AS body, a.attachable_type = 'message' AND ${speech("a")} AS live, ` +
      "'personal' AS scope FROM attachments a WHERE a.id = ?",
    pieces: false,
  },
  event: {
    type: "event",
    index: "event_index",
    table: "events",
    read:
      `SELECT e.title, ${EVENT_TEXT} AS body, ${EVENT_LIVE} AS live, ` +
      "coalesce((SELECT a.scope FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id " +
      "JOIN accounts a ON a.id = c.account_id WHERE ce.event_id = e.id LIMIT 1), 'personal') AS scope, " +
      "(SELECT c.account_id FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id " +
      "WHERE ce.event_id = e.id AND ce.deleted_at IS NULL ORDER BY ce.id LIMIT 1) AS account_id FROM events e WHERE e.id = ?",
  },
} as const satisfies Record<string, Corpus>

/** What a row is indexed as: its title, then its text. Chunk offsets point into this. */
export const noteIndexText = (title: string | null, text: string): string => (title ? `${title}\n\n${text}` : text)

const queuedAs = (corpus: Corpus) => corpus.queued ?? corpus.type

const hasTrigrams = (corpus: Corpus): corpus is Corpus & { type: "note" | "document" } =>
  corpus.type === "note" || corpus.type === "document"

/**
 * `column` (a note's or document's id) is a row whose title or text holds `search` anywhere, in any letter case;
 * no condition for an empty `search`. A row the trigrams do not hold yet — waiting in its queue, or stored before
 * version 40 and not yet reached by `fillTrigrams` — is matched by its text as SQLite's `lower()` reads it.
 */
export const holdingText = (type: "note" | "document", column: string, search: string): Where | undefined => {
  const text = normalize(search)
  if (text === "") return undefined
  // A trigram index answers a shorter query with nothing, silently.
  if ([...text].length < 3) throw new CliError("validation_error", "search needs at least three characters")
  const queued = `SELECT id FROM ${type}_index_pending WHERE indexable_type = '${type}'`
  const state = (field: string) => `(SELECT ${field} FROM search_index_state WHERE name = '${type}_trigrams')`
  return {
    sql:
      `${column} IN (SELECT rowid FROM ${type}_trigrams WHERE ${type}_trigrams MATCH ? AND rowid NOT IN (${queued}) ` +
      `UNION ALL SELECT r.id FROM ${type}s r WHERE (r.id IN (${queued}) OR (r.id > ${state("filled_through")} ` +
      `AND r.id <= ${state("watermark")})) AND instr(lower(coalesce(r.body, '')), lower(?)) > 0)`,
    params: [`"${text.replaceAll('"', '""')}"`, search],
  }
}

/**
 * Writes the trigrams of the notes and documents stored before version 40, in short write transactions, up to the
 * highest id the migration found; later rows get theirs from the drain. Stopping between batches loses nothing.
 */
export const fillTrigrams = (
  database: CacheDatabase,
  { batch = 200, until = () => false }: { batch?: number; until?: () => boolean } = {},
): number => {
  let filled = 0
  for (const type of ["document", "note"] as const) {
    const name = `${type}_trigrams`
    const state = database.prepare("SELECT watermark, filled_through FROM search_index_state WHERE name = ?")
    const rows = database.prepare(
      `SELECT id, title, coalesce(body, '') AS body FROM ${type}s WHERE id > ? AND id <= ? AND deleted_at IS NULL ` +
        "ORDER BY id LIMIT ?",
    )
    const drop = database.prepare(`DELETE FROM ${name} WHERE rowid = ?`)
    const add = database.prepare(`INSERT INTO ${name} (rowid, text) VALUES (?, ?)`)
    const reached = database.prepare("UPDATE search_index_state SET filled_through = ? WHERE name = ?")
    for (;;) {
      const at = state.get(name)
      const mark = Number(at?.watermark ?? 0)
      if (Number(at?.filled_through ?? mark) >= mark || until()) break
      filled += write(database, () => {
        const page = rows.all(Number(at?.filled_through), mark, batch)
        for (const row of page) {
          const text = normalize(noteIndexText(row.title == null ? null : String(row.title), String(row.body)))
          drop.run(Number(row.id))
          if (text !== "") add.run(Number(row.id), text)
        }
        reached.run(page.length < batch ? mark : Number(page.at(-1)?.id), name)
        return page.length
      })
    }
  }
  return filled
}

export const corpusIndexState = (database: CacheDatabase, corpus: Corpus): NoteIndexState => {
  const row = indexRow(database, corpus.index) as Record<string, unknown>
  const pending = Number(
    database
      .prepare(`SELECT count(*) AS n FROM ${corpus.type}_index_pending WHERE indexable_type = ?`)
      .get(queuedAs(corpus))?.n,
  )
  const saved = savedStemmers(database)
  const wanted = saved === null ? null : analyzerIdentity(saved ?? DEFAULT_STEMMERS)
  const built = row.analyzer === null ? null : String(row.analyzer)
  return { pending, built, wanted, ready: pending === 0 && wanted !== null && (built === wanted || built === null) }
}

/** Documents and notes together: what a notes search reads. */
export const noteIndexState = (database: CacheDatabase): NoteIndexState => {
  const documents = corpusIndexState(database, CORPORA.document)
  const notes = corpusIndexState(database, CORPORA.note)
  return {
    pending: documents.pending + notes.pending,
    built: notes.built ?? documents.built,
    wanted: notes.wanted,
    ready: documents.ready && notes.ready,
  }
}

const storedSections = (metadata: string): { start: number }[] => {
  try {
    const { sections } = JSON.parse(metadata) as { sections?: { start?: unknown }[] }
    return (sections ?? []).filter((section): section is { start: number } => Number.isInteger(section.start))
  } catch {
    return []
  }
}

const writer = (database: CacheDatabase, corpus: Corpus, stemmer: Stemmer) => {
  const read = database.prepare(corpus.read)
  const oldHashes = database.prepare(
    "SELECT content_hash AS hash FROM chunks WHERE chunkable_type = ? AND chunkable_id = ?",
  )
  const statements = {
    dropWords: database.prepare(`DELETE FROM ${corpus.type}_words WHERE rowid = ?`),
    dropStems: database.prepare(`DELETE FROM ${corpus.type}_stems WHERE rowid = ?`),
    dropTrigrams: hasTrigrams(corpus) ? database.prepare(`DELETE FROM ${corpus.type}_trigrams WHERE rowid = ?`) : null,
    dropChunks: database.prepare("DELETE FROM chunks WHERE chunkable_type = ? AND chunkable_id = ?"),
    words: database.prepare(`INSERT INTO ${corpus.type}_words (rowid, normalized_text, scope) VALUES (?, ?, ?)`),
    stems: database.prepare(`INSERT INTO ${corpus.type}_stems (rowid, stems, scope) VALUES (?, ?, ?)`),
    trigrams: hasTrigrams(corpus)
      ? database.prepare(`INSERT INTO ${corpus.type}_trigrams (rowid, text) VALUES (?, ?)`)
      : null,
    chunk: database.prepare(
      "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, account_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    dequeue: database.prepare(`DELETE FROM ${corpus.type}_index_pending WHERE indexable_type = ? AND id = ?`),
  }
  return (id: number) => {
    const row = read.get(id)
    const before = oldHashes.all(corpus.type, id).map((hash) => String(hash.hash))
    statements.dropWords.run(id)
    statements.dropStems.run(id)
    statements.dropTrigrams?.run(id)
    statements.dropChunks.run(corpus.type, id)
    const live = row !== undefined && Number(row.live) === 1
    const text = live ? noteIndexText(row.title == null ? null : String(row.title), String(row.body)) : ""
    const scope = live ? String(row.scope ?? "personal") : ""
    const terms = corpus.terms && text ? corpus.terms(text, stemmer) : undefined
    const words = terms ? terms.words : normalize(text)
    if (words !== "") {
      statements.words.run(id, words, scope)
      statements.trigrams?.run(id, words)
    }
    const stems = terms ? terms.stems : text ? stemmer.indexText(text) : ""
    if (stems !== "") statements.stems.run(id, stems, scope)
    if (text.trim() && corpus.pieces !== false) {
      const at = Date.now()
      const sections = row?.metadata == null ? [] : storedSections(String(row.metadata))
      const ranges = sections.length
        ? splitSections(text, sections, CHUNK_CHARS, text.length - String(row?.body ?? "").length)
        : splitText(text, CHUNK_CHARS)
      ranges.forEach(({ start, end }, position) => {
        const hash = chunkHash(text.slice(start, end))
        statements.chunk.run(corpus.type, id, position, start, end, hash, scope, int(row?.account_id), at, at)
      })
    }
    dropUnusedVectors(database, before)
    if (!live && corpus.type === "document") dropDocumentPicture(database, id)
    statements.dequeue.run(queuedAs(corpus), id)
  }
}

/**
 * Indexes one corpus's rows written since the last drain, in short write transactions. These corpora are
 * small, so a change of stemmer choices simply queues every row again instead of waiting for `store rebuild`.
 */
export const drainCorpus = (
  database: CacheDatabase,
  corpus: Corpus,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  { batch = 200, until = () => false }: { batch?: number; until?: () => boolean } = {},
): number => {
  // Pieces written before they carried their account get it, once: purge and vector search filter by it.
  if (corpus.type === "email" || corpus.type === "document")
    database
      .prepare(
        `UPDATE chunks SET account_id = (SELECT account_id FROM ${corpus.table} WHERE id = chunks.chunkable_id)
          WHERE chunkable_type = ? AND account_id IS NULL`,
      )
      .run(corpus.type)
  // The first schema seeded no row for mail; a data row, so no migration.
  database
    .prepare(
      "INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version) VALUES (?, 0, 0, 0, 1)",
    )
    .run(corpus.index)
  const state = corpusIndexState(database, corpus)
  if (state.wanted === null) return 0
  const stemmer = stemmerFor(savedStemmers(database) ?? DEFAULT_STEMMERS)
  const queue = `${corpus.type}_index_pending`
  if (state.built !== stemmer.identity) {
    write(database, () => {
      if (state.built !== null)
        database
          .prepare(`INSERT OR IGNORE INTO ${queue} (indexable_type, id) SELECT ?, id FROM ${corpus.table}`)
          .run(queuedAs(corpus))
      database.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = ?").run(stemmer.identity, corpus.index)
    })
  }
  if (state.pending === 0 && state.built === stemmer.identity) return 0
  const next = database.prepare(`SELECT id FROM ${queue} WHERE indexable_type = ? ORDER BY id LIMIT ?`)
  const index = writer(database, corpus, stemmer)
  let done = 0
  for (;;) {
    if (until()) break
    const count = write(database, () => {
      const ids = next.all(queuedAs(corpus), batch).map((row) => Number(row.id))
      for (const id of ids) index(id)
      return ids.length
    })
    if (count === 0) break
    done += count
  }
  return done
}

/** Documents, then notes: what a notes search reads; then the trigrams still to fill. */
export const drainNoteIndex = (
  database: CacheDatabase,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  options: { batch?: number; until?: () => boolean } = {},
): number =>
  drainCorpus(database, CORPORA.document, stemmerFor, options) +
  drainCorpus(database, CORPORA.note, stemmerFor, options) +
  fillTrigrams(database, options)

/** Queues every document, note and memory again — for `store rebuild`. */
export const resetNoteIndex = (database: CacheDatabase): boolean => {
  write(database, () => {
    for (const corpus of Object.values(CORPORA))
      database
        .prepare(
          `INSERT OR IGNORE INTO ${corpus.type}_index_pending (indexable_type, id) SELECT ?, id FROM ${corpus.table}`,
        )
        .run(queuedAs(corpus))
  })
  return true
}
