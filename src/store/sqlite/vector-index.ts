import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import { writeBatch } from "./transaction.js"

/**
 * One sqlite-vec `vec0` table per embedding model, a row per chunk that has a vector of that model: rowid is
 * `chunks.id`. The static triggers of store version 34 push every changed chunk id through `vector_index_redo`, and
 * each model's own trigger re-derives that chunk's row, so every writer — the store's functions, the schema's own
 * delete triggers, a raw `DELETE` — keeps the index in step inside its own transaction.
 *
 * `kind` and `account` are partition keys, `occurred_at` and `chat` metadata: the filters a KNN query applies before
 * it ranks. `account`, `chat` and `occurred_at` are the columns each kind's scan filters on, so the index never
 * leaves out a row the scan would keep; filters it cannot express are checked on the candidates after.
 */
const source = (model: string, dims: number) => `SELECT k.id, k.chunkable_type,
    coalesce(CASE k.chunkable_type
      WHEN 'image' THEN (SELECT ch.account_id FROM attachments a JOIN messages m ON m.id = a.attachable_id
        JOIN chats ch ON ch.id = m.chat_id WHERE a.id = k.chunkable_id AND a.attachable_type = 'message')
      WHEN 'conversation' THEN (SELECT ch.account_id FROM conversations c JOIN chats ch ON ch.id = c.chat_id
        WHERE c.id = k.chunkable_id)
      ELSE k.account_id END, 0),
    coalesce(CASE k.chunkable_type
      WHEN 'message' THEN (SELECT m.chat_id FROM messages m WHERE m.id = k.chunkable_id)
      WHEN 'image' THEN (SELECT m.chat_id FROM attachments a JOIN messages m ON m.id = a.attachable_id
        WHERE a.id = k.chunkable_id AND a.attachable_type = 'message')
      WHEN 'conversation' THEN (SELECT c.chat_id FROM conversations c WHERE c.id = k.chunkable_id) END, 0),
    coalesce(CASE k.chunkable_type
      WHEN 'message' THEN (SELECT m.sent_at FROM messages m WHERE m.id = k.chunkable_id)
      ELSE k.occurred_at END, 0),
    v.vector, k.content_hash
  FROM chunks k JOIN embeddings v ON v.model = ${literal(model)} AND v.content_hash = k.content_hash
    AND length(v.vector) = ${dims * 4}`

/**
 * Every stored vector has length one, so the scan's dot product and the index's cosine rank alike. A model that
 * already gives unit vectors (e5, the API models) changes by float rounding only. A zero vector (a text the model
 * knows nothing of) stays zero: vec0 puts it first with no distance, so it is always among the candidates and scores
 * 0 both ways.
 */
export const unitVector = (vector: Float32Array): Float32Array => {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  if (!Number.isFinite(length))
    throw new CliError("validation_error", "a vector must have finite values", { reason: "store.vector-invalid" })
  return length === 0 ? vector : vector.map((value) => value / length)
}

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

const COLUMNS = "rowid, kind, account, chat, occurred_at, embedding, hash"

export interface VectorIndex {
  table: string
  dims: number
  ready: boolean
}

const tableOf = (id: number) => `vector_index_${id}`

export const vectorIndexOf = (database: CacheDatabase, model: string): VectorIndex | undefined => {
  const row = database.prepare("SELECT id, dims, ready FROM vector_indexes WHERE model = ?").get(model)
  return row && { table: tableOf(Number(row.id)), dims: Number(row.dims), ready: row.ready === 1 }
}

/**
 * The model's index, made on its first vector. A model that already has vectors (an older store) is filled by
 * `fillVectorIndexes` in short batches, and searched by scan until it is ready.
 */
export const ensureVectorIndex = (database: CacheDatabase, model: string, dims: number): void => {
  if (vectorIndexOf(database, model)) return
  const held = database.prepare("SELECT 1 FROM embeddings WHERE model = ? LIMIT 1").get(model) !== undefined
  const id = Number(
    database
      .prepare("INSERT INTO vector_indexes (model, dims, ready, filled_through) VALUES (?, ?, ?, '') RETURNING id")
      .get(model, dims, held ? 0 : 1)?.id,
  )
  const table = tableOf(id)
  database.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(kind text partition key, account integer partition key,
    chat integer, occurred_at integer, embedding float[${dims}] distance_metric=cosine, +hash text)`)
  database.exec(`CREATE TRIGGER ${table}_redo AFTER INSERT ON vector_index_redo BEGIN
    DELETE FROM ${table} WHERE rowid = new.chunk_id;
    INSERT INTO ${table} (${COLUMNS}) ${source(model, dims)} WHERE k.id = new.chunk_id;
  END`)
}

/** The models with vectors and no index, by a walk of the primary key rather than a scan of every vector. */
const modelsWithoutIndex = (database: CacheDatabase) =>
  database
    .prepare(
      `WITH RECURSIVE m(model) AS (SELECT min(model) FROM embeddings
         UNION ALL SELECT (SELECT min(model) FROM embeddings WHERE model > m.model) FROM m WHERE m.model IS NOT NULL)
       SELECT m.model, (SELECT dims FROM embeddings WHERE model = m.model LIMIT 1) AS dims FROM m
       WHERE m.model IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vector_indexes i WHERE i.model = m.model)`,
    )
    .all() as { model: string; dims: number }[]

/** Hashes per batch: a batch is one short write transaction, so other processes wait less than their timeout. */
const FILL_HASHES = 1_000

/**
 * Indexes the vectors a store held before its index existed, in hash order from where the last batch stopped. Rows
 * the triggers wrote meanwhile are skipped. Returns the models it filled.
 */
export const fillVectorIndexes = (
  database: CacheDatabase,
  { batch = FILL_HASHES, notice = () => {} }: { batch?: number; notice?: (model: string) => void } = {},
): string[] => {
  for (const { model, dims } of modelsWithoutIndex(database))
    writeBatch(database, () => ensureVectorIndex(database, model, Number(dims)))
  const pending = database
    .prepare("SELECT id, model, dims, filled_through FROM vector_indexes WHERE ready = 0 ORDER BY id")
    .all() as { id: number; model: string; dims: number; filled_through: string }[]
  for (const { id, model, dims, filled_through } of pending) {
    notice(model)
    const table = tableOf(id)
    const step = database.prepare(
      `INSERT INTO ${table} (${COLUMNS}) ${source(model, dims)}
        WHERE k.content_hash IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM ${table} WHERE rowid = k.id)`,
    )
    const hashes = database.prepare(
      "SELECT content_hash AS hash FROM embeddings WHERE model = ? AND content_hash > ? ORDER BY content_hash LIMIT ?",
    )
    let after = filled_through
    for (;;) {
      const done = writeBatch(database, () => {
        const page = (hashes.all(model, after, batch) as { hash: string }[]).map(({ hash }) => hash)
        if (page.length > 0) step.run(JSON.stringify(page))
        after = page.at(-1) ?? after
        const finished = page.length < batch
        // Another process may be filling too: neither moves the other back, nor un-readies a finished index.
        database
          .prepare(
            "UPDATE vector_indexes SET filled_through = ?, ready = ? WHERE id = ? AND ready = 0 AND filled_through <= ?",
          )
          .run(after, finished ? 1 : 0, id, after)
        return finished
      })
      if (done) break
    }
  }
  return pending.map(({ model }) => model)
}

export interface IndexFilter {
  kind: string
  account: number
  chat?: number
  since?: number
  before?: number
}

/**
 * vec0 measures in float32 and the scan in float64, so two results closer than this may swap. Far above float32's
 * error at these lengths, far below any distance that matters for ranking.
 */
const NEAR_TIE = 1e-5

/** vec0 refuses a k above this. */
const MAX_K = 4_096

export interface Candidate {
  id: number
  hash: string
  /** None for a zero vector. */
  distance: number | null
}

const knn = (database: CacheDatabase, index: VectorIndex, filter: IndexFilter, query: Float32Array, k: number) =>
  database
    .prepare(
      `SELECT rowid AS id, hash, distance FROM ${index.table} WHERE embedding MATCH ? AND k = ? AND kind = ? AND account = ?
        ${filter.chat === undefined ? "" : "AND chat = ?"}
        ${filter.since === undefined ? "" : "AND occurred_at >= ?"}
        ${filter.before === undefined ? "" : "AND occurred_at < ?"}`,
    )
    .all(
      new Uint8Array(query.buffer, query.byteOffset, query.byteLength),
      BigInt(k),
      filter.kind,
      // node:sqlite binds a JS number as REAL, which vec0's integer columns refuse.
      BigInt(filter.account),
      ...[filter.chat, filter.since, filter.before].flatMap((value) => (value === undefined ? [] : [BigInt(value)])),
    ) as unknown as Candidate[]

/**
 * The best `limit` results by the index, or `undefined` when the caller must scan: no ready index for the model, or
 * no exact answer within the most candidates vec0 returns. `survivors` applies the scan's own SQL to the candidates,
 * in the scan's order (and checks each one's hash, so a reused chunk id is never taken for the old chunk), scores
 * them, and names the chunks behind its best `limit` results. Those are exact once each is nearer than the last
 * candidate by more than `NEAR_TIE`: every row nearer than that is among the candidates, and the rest cannot outrank
 * them even where float32 and float64 disagree. A text many
 * chunks share has one vector, so a tie that crosses the last candidate asks for more, as the scan's order decides it.
 */
export const searchIndex = <T>(
  database: CacheDatabase,
  model: string,
  filter: IndexFilter,
  query: Float32Array,
  limit: number,
  survivors: (candidates: Candidate[]) => { results: T[]; best: number[] },
): T[] | undefined => {
  const index = vectorIndexOf(database, model)
  if (!index?.ready || index.dims !== query.length) return undefined
  let k = Math.min(MAX_K, Math.max(100, limit * 4))
  for (;;) {
    const candidates = knn(database, index, filter, query, k)
    const { results, best } = survivors(candidates)
    if (candidates.length < k) return results
    const edge = candidates.at(-1)?.distance ?? null
    const distance = new Map(candidates.map((candidate) => [candidate.id, candidate.distance]))
    // A last candidate with no distance is a zero vector: nothing is known to be nearer yet.
    const nearer = (id: number) => edge !== null && (distance.get(id) ?? edge) < edge - NEAR_TIE
    if (best.length >= limit && best.every(nearer)) return results
    if (k === MAX_K) return undefined
    k = Math.min(MAX_K, k * 4)
  }
}

/**
 * Per model, `store check`'s safety net: the rows its index holds against the rows `source` derives now, compared
 * whole (chunk, kind, account, chat, time, hash, vector) both ways. `missing` are rows the index lacks or holds
 * wrong; `extra` rows it should not hold.
 */
export const vectorIndexCounts = (database: CacheDatabase) =>
  (
    database.prepare("SELECT id, model, dims, ready FROM vector_indexes ORDER BY id").all() as {
      id: number
      model: string
      dims: number
      ready: number
    }[]
  ).map(({ id, model, dims, ready }) => {
    const held = `SELECT ${COLUMNS} FROM ${tableOf(id)}`
    const wanted = source(model, Number(dims))
    const count = (sql: string) => Number(database.prepare(`SELECT count(*) AS n FROM (${sql})`).get()?.n ?? 0)
    return {
      model,
      dims: Number(dims),
      ready: ready === 1,
      indexed: count(held),
      expected: count(wanted),
      missing: count(`${wanted} EXCEPT ${held}`),
      extra: count(`${held} EXCEPT ${wanted}`),
    }
  })
