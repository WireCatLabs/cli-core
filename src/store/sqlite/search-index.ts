import { trigrams } from "../../search/trigrams.js"
import type { CacheDatabase } from "../driver.js"
import { backfillNormalized, pendingNormalization } from "./backfill.js"
import { indexRow } from "./index-state.js"
import { writeBatch } from "./transaction.js"

const INDEX = "message_words"

export interface SearchIndexState {
  /** The highest message the batches must reach; newer ones are indexed by triggers. */
  watermark: number
  filledThrough: number
  pendingNormalization: number
  /** Every live message is in the word index: search may rank by words. */
  ready: boolean
  /** The typo vocabulary covers the messages up to this one; 0 while it is not built. */
  termsThrough: number
  /** The newest stored message. */
  newest: number
  /** The typo vocabulary covers every stored message; `ready` does not wait for it. */
  termsReady: boolean
  builtAt: string | null
}

export interface SearchIndexFill {
  normalized: number
  indexed: number
  terms: number
}

/** `undefined` on a file before version 12, which has no word index. */
export const searchIndexState = (database: CacheDatabase): SearchIndexState | undefined => {
  const row = indexRow(database, INDEX)
  if (!row) return undefined
  const watermark = Number(row.watermark)
  const filledThrough = Number(row.filled_through)
  const pending = pendingNormalization(database)
  const termsThrough = Number(row.terms_through)
  const newest = newestMessage(database)
  return {
    watermark,
    filledThrough,
    pendingNormalization: pending,
    ready: filledThrough >= watermark && pending === 0,
    termsThrough,
    newest,
    termsReady: termsThrough >= newest,
    builtAt: row.built_at === null ? null : new Date(Number(row.built_at)).toISOString(),
  }
}

/**
 * Brings the word index to "ready", in short write transactions so other processes wait for one batch
 * at most: the normalized text first — a message without it cannot be indexed — then the messages up
 * to the watermark, then the typo vocabulary. `until` stops it between batches; stopping loses nothing.
 */
export const fillSearchIndex = (
  database: CacheDatabase,
  {
    batch = 5_000,
    until = () => false,
    onBatch,
    now = Date.now,
  }: { batch?: number; until?: () => boolean; onBatch?: (step: string, done: number) => void; now?: () => number } = {},
): SearchIndexFill => {
  const filled: SearchIndexFill = { normalized: 0, indexed: 0, terms: 0 }
  const before = searchIndexState(database)
  // Every search asks; when all is built it must not take the write lock.
  if (!before || (before.ready && before.termsReady)) return filled
  if (before.pendingNormalization > 0) {
    filled.normalized = backfillNormalized(database, {
      batch,
      until,
      onBatch: (done) => onBatch?.("normalized", done),
    })
  }

  const index = database.prepare(
    `INSERT OR REPLACE INTO message_words (rowid, normalized_text, scope)
       SELECT id AS pk, normalized_text, 'c' || chat_id || coalesce(' s' || sender_identity_id, '')
       FROM messages WHERE id > ? AND id <= ? AND normalized_text <> ''`,
  )
  const advance = database.prepare("UPDATE search_index_state SET filled_through = ? WHERE name = ?")
  for (;;) {
    const state = searchIndexState(database)
    if (!state || state.filledThrough >= state.watermark || until()) break
    const to = Math.min(state.filledThrough + batch, state.watermark)
    filled.indexed += writeBatch(database, () => {
      const { changes } = index.run(state.filledThrough, to)
      advance.run(to, INDEX)
      return changes
    })
    onBatch?.("indexed", filled.indexed)
  }

  const state = searchIndexState(database)
  if (state && state.filledThrough >= state.watermark && state.builtAt === null) {
    database.prepare("UPDATE search_index_state SET built_at = ? WHERE name = ?").run(now(), INDEX)
  }
  if (state?.ready && state.termsThrough === 0) filled.terms = buildTerms(database, { batch, until, onBatch })
  if (state?.ready) filled.terms += refreshTerms(database, { batch, until, onBatch })
  return filled
}

const newestMessage = (database: CacheDatabase) =>
  Number(database.prepare("SELECT coalesce(max(id), 0) AS pk FROM messages").get()?.pk)

const termWriters = (database: CacheDatabase) => {
  const term = database.prepare("INSERT OR IGNORE INTO search_terms (term, length) VALUES (?, ?)")
  const trigram = database.prepare(
    "INSERT OR IGNORE INTO search_term_trigrams (trigram, length, term) VALUES (?, ?, ?)",
  )
  return (word: string) => {
    term.run(word, word.length)
    if (!/^\d+$/.test(word)) for (const piece of trigrams(word)) trigram.run(piece, word.length, word)
  }
}

/**
 * Adds the words of messages stored after the vocabulary was built, split as the index splits the
 * normalized text — accents and case are already gone from it. A word only a deleted message had may
 * be added; the lookup drops it, since the index no longer knows it.
 */
const refreshTerms = (
  database: CacheDatabase,
  { batch, until, onBatch }: { batch: number; until: () => boolean; onBatch?: (step: string, done: number) => void },
): number => {
  const newest = newestMessage(database)
  const texts = database.prepare(
    "SELECT normalized_text AS text FROM messages WHERE id > ? AND id <= ? AND normalized_text <> ''",
  )
  const advance = database.prepare("UPDATE search_index_state SET terms_through = ? WHERE name = ?")
  const addTerm = termWriters(database)
  let added = 0
  for (;;) {
    const through = Number(searchIndexState(database)?.termsThrough)
    if (through >= newest || until()) return added
    const to = Math.min(through + batch, newest)
    writeBatch(database, () => {
      const words = new Set(
        texts.all(through, to).flatMap((row) =>
          String(row.text)
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean),
        ),
      )
      for (const word of words) addTerm(word)
      advance.run(to, INDEX)
      added += words.size
    })
    onBatch?.("terms", added)
  }
}

/**
 * The typo vocabulary, from the index's own list of words — `col`, so the chat and sender tokens are
 * never words. In term order, each batch committed, so a run stopped half-way resumes after the last
 * term it wrote. Numbers get no trigrams: a mistyped number is another number, not a typo.
 */
const buildTerms = (
  database: CacheDatabase,
  { batch, until, onBatch }: { batch: number; until: () => boolean; onBatch?: (step: string, done: number) => void },
): number => {
  const through = Number(database.prepare("SELECT coalesce(max(id), 0) AS pk FROM messages").get()?.pk)
  const next = database.prepare(
    `SELECT term FROM message_words_vocab WHERE col = 'normalized_text' AND term > ? ORDER BY term LIMIT ?`,
  )
  const addTerm = termWriters(database)
  let after = String(database.prepare("SELECT coalesce(max(term), '') AS term FROM search_terms").get()?.term)
  let written = 0
  for (;;) {
    if (until()) return written
    const terms = next.all(after, batch).map((row) => String(row.term))
    if (terms.length === 0) break
    writeBatch(database, () => {
      for (const word of terms) addTerm(word)
    })
    written += terms.length
    after = terms.at(-1) ?? after
    onBatch?.("terms", written)
  }
  // 0 means "not built", so an empty file still records that it was.
  database.prepare("UPDATE search_index_state SET terms_through = ? WHERE name = ?").run(Math.max(through, 1), INDEX)
  return written
}

/**
 * Empties the word index and its vocabulary and starts the fill again from the newest message — for
 * `store rebuild`. Messages written meanwhile are indexed by the triggers, as after the migration.
 */
export const resetSearchIndex = (database: CacheDatabase): void => {
  if (!searchIndexState(database)) return
  writeBatch(database, () => {
    database.exec(`INSERT INTO ${INDEX} (${INDEX}) VALUES ('delete-all')`)
    database.exec("DELETE FROM search_terms")
    database.exec("DELETE FROM search_term_trigrams")
    database
      .prepare(
        `UPDATE search_index_state SET watermark = (SELECT coalesce(max(id), 0) FROM messages),
           filled_through = 0, terms_through = 0, built_at = NULL WHERE name = ?`,
      )
      .run(INDEX)
  })
}
