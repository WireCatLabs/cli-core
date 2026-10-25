import { CHUNK_CHARS, type Chunk, type ChunkLine, chunkHash, cutChunks, splitText } from "../../conversations/chunks.js"
import { mailCore } from "../../conversations/mail-text.js"
import type { Stemmer, Stemmers } from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { int, str } from "./events.js"
import { CORPORA, drainCorpus } from "./note-index.js"
import { write } from "./transaction.js"
import { dropUnusedVectors } from "./vector-index.js"

export const titleOf = (subject: string | null): string | null =>
  subject?.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim() || null

/**
 * Every piece of mail: a stretch of a thread, or of one email's attachment. A thread piece holds no email of its
 * own; `threadPieces` cuts the thread again to find which emails it spans.
 */
export const MAIL_PIECES = `(SELECT k.id, k.content_hash, k.chunkable_type AS type, k.chunkable_id AS owner, k.position,
    k.start_offset, k.end_offset, k.account_id, k.occurred_at, a.attachable_id AS email_id,
    CASE k.chunkable_type WHEN 'email_thread' THEN k.chunkable_id
      ELSE (SELECT email_thread_id FROM emails WHERE id = a.attachable_id) END AS thread_id
    FROM chunks k LEFT JOIN attachments a ON k.chunkable_type = 'attachment' AND a.id = k.chunkable_id
      AND a.attachable_type = 'email'
   WHERE k.chunkable_type = 'email_thread' OR a.id IS NOT NULL) p`

interface ThreadText {
  lines: ChunkLine[]
  at: Map<string, number | null>
}

/** A thread's live emails, oldest first, each as what it adds: its subject, then its own text. */
const threadText = (database: CacheDatabase, threadId: number): ThreadText => {
  const rows = database
    .prepare(
      `SELECT id, subject, coalesce(body_text, '') AS body, coalesce(from_name, from_address) AS sender,
         coalesce(received_at, sent_at) AS at
         FROM emails WHERE email_thread_id = ? AND deleted_at IS NULL ORDER BY coalesce(sent_at, received_at), id`,
    )
    .all(threadId)
  const earlier: string[] = []
  const at = new Map<string, number | null>()
  const lines = rows.map((row) => {
    const body = String(row.body)
    const core = mailCore(body, earlier)
    earlier.push(body)
    const subject = titleOf(str(row.subject))
    const text = subject ? `${subject}\n\n${core}` : core
    at.set(String(row.id), int(row.at) ?? null)
    return { id: String(row.id), sender: str(row.sender), text }
  })
  return { lines, at }
}

/**
 * A thread's pieces, email by email: a piece never spans two emails, so a hit names the email that holds it
 * (bench/mail-quality). A new reply adds its own pieces; every earlier one keeps its hash and so its vector.
 */
export const threadPieces = (database: CacheDatabase, threadId: number): Chunk[] =>
  cutThread(threadText(database, threadId).lines)

/** The one cut of a thread: what is stored, what is embedded and what a hit is read back from must agree. */
const cutThread = (lines: ChunkLine[]): Chunk[] => lines.flatMap((line) => cutChunks([line], CHUNK_CHARS))

const chunkThread = (database: CacheDatabase, threadId: number, now: number) => {
  const before = database
    .prepare("SELECT content_hash AS hash FROM chunks WHERE chunkable_type = 'email_thread' AND chunkable_id = ?")
    .all(threadId)
    .map(({ hash }) => String(hash))
  database.prepare("DELETE FROM chunks WHERE chunkable_type = 'email_thread' AND chunkable_id = ?").run(threadId)
  const thread = database
    .prepare("SELECT t.account_id, a.scope FROM email_threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?")
    .get(threadId)
  if (thread) {
    const { lines, at } = threadText(database, threadId)
    const insert = database.prepare(
      `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, account_id,
         occurred_at, created_at, updated_at) VALUES ('email_thread', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [position, piece] of cutThread(lines).entries())
      insert.run(
        threadId,
        position,
        piece.text.length,
        piece.hash,
        str(thread.scope),
        Number(thread.account_id),
        at.get(piece.lastId) ?? null,
        now,
        now,
      )
  }
  dropUnusedVectors(database, before)
}

export const queueThreads = (database: CacheDatabase, ids: Iterable<number>) => {
  const queue = database.prepare(
    "INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email_thread', ?)",
  )
  for (const id of ids) queue.run(id)
}

const ATTACHMENTS_OF_EMAIL = "SELECT id FROM attachments WHERE attachable_type = 'email' AND attachable_id = ?"

/** Drops the pieces of an email's attachment texts; answers their hashes, for `dropUnusedVectors` once new ones are in. */
export const dropAttachmentChunks = (database: CacheDatabase, emailId: number): string[] => {
  const hashes = database
    .prepare(
      `SELECT content_hash AS hash FROM chunks WHERE chunkable_type = 'attachment' AND chunkable_id IN (${ATTACHMENTS_OF_EMAIL})`,
    )
    .all(emailId)
    .map(({ hash }) => String(hash))
  database
    .prepare(`DELETE FROM chunks WHERE chunkable_type = 'attachment' AND chunkable_id IN (${ATTACHMENTS_OF_EMAIL})`)
    .run(emailId)
  return hashes
}

/** Each attachment's extracted text, in pieces for search by meaning, as an email's own text is. */
export const chunkAttachments = (database: CacheDatabase, accountId: number, emailId: number, now: number) => {
  const email = database
    .prepare(
      "SELECT a.scope, coalesce(e.received_at, e.sent_at) AS at FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ?",
    )
    .get(emailId)
  const insert = database.prepare(
    `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, account_id,
       occurred_at, created_at, updated_at) VALUES ('attachment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const files = database
    .prepare("SELECT id, text FROM attachments WHERE attachable_type = 'email' AND attachable_id = ? AND text <> ''")
    .all(emailId)
  for (const file of files) {
    const text = String(file.text)
    for (const [position, { start, end }] of splitText(text, CHUNK_CHARS).entries())
      insert.run(
        Number(file.id),
        position,
        start,
        end,
        chunkHash(text.slice(start, end)),
        str(email?.scope),
        accountId,
        int(email?.at),
        now,
        now,
      )
  }
}

const MAIL_CUT = "mail_pieces_cut"
const CUT = "email"

export const drainEmailIndex = (database: CacheDatabase, stemmerFor: (stemmers: Stemmers) => Stemmer): number => {
  // Mail was once cut without cleaning, then across the emails of a thread; a store cut either way is cut again.
  if (database.prepare("SELECT value FROM store_settings WHERE key = ?").get(MAIL_CUT)?.value !== CUT)
    write(database, () => {
      const single = database
        .prepare("SELECT DISTINCT content_hash AS hash FROM chunks WHERE chunkable_type = 'email'")
        .all()
        .map(({ hash }) => String(hash))
      database.prepare("DELETE FROM chunks WHERE chunkable_type = 'email'").run()
      queueThreads(
        database,
        database
          .prepare("SELECT id FROM email_threads")
          .all()
          .map(({ id }) => Number(id)),
      )
      dropUnusedVectors(database, single)
      database
        .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
        .run(MAIL_CUT, CUT, Date.now())
    })
  database
    .prepare(
      `INSERT OR IGNORE INTO email_index_pending (indexable_type, id)
         SELECT DISTINCT 'email_thread', e.email_thread_id FROM email_index_pending q JOIN emails e ON e.id = q.id
          WHERE q.indexable_type = 'email' AND e.email_thread_id IS NOT NULL`,
    )
    .run()
  // Attachments saved before their text was cut into pieces get them here, once.
  const unchunked = database
    .prepare(
      `SELECT DISTINCT e.id, e.account_id FROM attachments a JOIN emails e ON a.attachable_type = 'email' AND e.id = a.attachable_id
        WHERE a.text <> '' AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM chunks k WHERE k.chunkable_type = 'attachment' AND k.chunkable_id = a.id)`,
    )
    .all()
  if (unchunked.length)
    write(database, () => {
      for (const row of unchunked) {
        const before = dropAttachmentChunks(database, Number(row.id))
        chunkAttachments(database, Number(row.account_id), Number(row.id), Date.now())
        dropUnusedVectors(database, before)
      }
    })
  const emails = drainCorpus(database, CORPORA.email, stemmerFor)
  const next = database.prepare(
    "SELECT id FROM email_index_pending WHERE indexable_type = 'email_thread' ORDER BY id LIMIT 50",
  )
  const done = database.prepare("DELETE FROM email_index_pending WHERE indexable_type = 'email_thread' AND id = ?")
  let threads = 0
  for (;;) {
    const count = write(database, () => {
      const ids = next.all().map(({ id }) => Number(id))
      for (const id of ids) {
        chunkThread(database, id, Date.now())
        done.run(id)
      }
      return ids.length
    })
    if (count === 0) break
    threads += count
  }
  return emails + threads
}
