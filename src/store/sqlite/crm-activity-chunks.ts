import { CHUNK_CHARS, chunkHash, splitText } from "../../conversations/chunks.js"
import { DEAL_KINDS, type DealKind } from "../../domain/deals.js"
import { type CacheDatabase, isQueryOnly } from "../driver.js"
import type { AccountKey } from "../types.js"
import { findAccountPk } from "./accounts.js"
import { type CopyViewer, viewerSql } from "./copy-viewer.js"
import { TABLES } from "./crm-rows.js"
import { noteIndexText } from "./index-text.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"
import { dropUnusedVectors, searchIndex } from "./vector-index.js"
import { dot } from "./vectors.js"

/** The `records.type` of a CRM activity or task. */
export const ACTIVITY_RECORD = "crm.activity"

/** `chunks.chunkable_type` of a CRM activity's pieces; `chunkable_id` is the activity's `records.id`. */
export const CRM_ACTIVITY_CHUNK = "crm_activity"

/**
 * An activity whose subject and text together, spaces aside, are shorter than this is not embedded: a task's `Call`
 * or `Follow up` says nothing alone and would sit near every query, as short tracker comments did. Its words still
 * find its deal.
 */
export const SHORTEST_EMBEDDED_ACTIVITY = 16

// SQLite's `trim` and `length` take spaces and code points; JavaScript's `trim` takes more, and `length` counts halves.
const EDGE = /^[ \t\n\r]+|[ \t\n\r]+$/gu
/** What an activity is embedded as, from its stored fields: chunk offsets point into it. */
const textOf = (subject: string, body: string | null): string =>
  [...`${subject}${body ?? ""}`.replace(EDGE, "")].length >= SHORTEST_EMBEDDED_ACTIVITY
    ? noteIndexText(subject, body ?? "")
    : ""

const piecesOf = (text: string) =>
  text
    ? splitText(text, CHUNK_CHARS).map(({ start, end }) => ({ start, end, hash: chunkHash(text.slice(start, end)) }))
    : []

export interface ChunkedActivity {
  id: number
  accountId: number
  subject: string
  body: string | null
  occurredAt: number
  scope: string | null
}

/**
 * Inside the caller's write: makes the activity's chunks its text's, and answers the hashes it released, or
 * `undefined` when they already were. The caller drops the vectors of those once every new chunk is in.
 */
export const crmActivityChunkWriter = (database: CacheDatabase) => {
  const held = database.prepare(
    `SELECT start_offset AS start, end_offset AS end, content_hash AS hash FROM chunks
      WHERE chunkable_type = '${CRM_ACTIVITY_CHUNK}' AND chunkable_id = ? ORDER BY position`,
  )
  const drop = database.prepare(
    `DELETE FROM chunks WHERE chunkable_type = '${CRM_ACTIVITY_CHUNK}' AND chunkable_id = ?`,
  )
  const insert = database.prepare(
    "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, " +
      `account_id, occurred_at, created_at, updated_at) VALUES ('${CRM_ACTIVITY_CHUNK}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  return (activity: ChunkedActivity, at: number): { released: string[] } | undefined => {
    const wanted = piecesOf(textOf(activity.subject, activity.body))
    const before = held.all(activity.id).map((row) => ({
      start: Number(row.start),
      end: Number(row.end),
      hash: String(row.hash),
    }))
    const same =
      before.length === wanted.length &&
      before.every((one, index) => {
        const other = wanted[index]
        return other !== undefined && one.start === other.start && one.end === other.end && one.hash === other.hash
      })
    if (same) return undefined
    drop.run(activity.id)
    wanted.forEach(({ start, end, hash }, position) => {
      insert.run(
        activity.id,
        position,
        start,
        end,
        hash,
        activity.scope,
        activity.accountId,
        activity.occurredAt,
        at,
        at,
      )
    })
    return { released: before.map(({ hash }) => hash) }
  }
}

/** Inside the caller's write: drops the chunks of these activities and the vectors no other chunk holds. */
export const dropCrmActivityChunks = (database: CacheDatabase, ids: readonly number[]): void => {
  if (!ids.length) return
  const released = database
    .prepare(
      `DELETE FROM chunks WHERE chunkable_type = '${CRM_ACTIVITY_CHUNK}'
        AND chunkable_id IN (SELECT value FROM json_each(?)) RETURNING content_hash AS hash`,
    )
    .all(JSON.stringify(ids))
    .map(({ hash }) => String(hash))
  dropUnusedVectors(database, released)
}

const COLUMNS =
  "r.id, r.account_id, json_extract(r.fields, '$.subject') AS subject, json_extract(r.fields, '$.body') AS body, " +
  "coalesce(json_extract(r.fields, '$.updated_at'), r.updated_at) AS at, a.scope"

const chunkedOf = (row: Record<string, unknown>): ChunkedActivity => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  subject: row.subject == null ? "" : String(row.subject),
  body: row.body == null ? null : String(row.body),
  occurredAt: Number(row.at),
  scope: row.scope == null ? null : String(row.scope),
})

/** Inside the caller's write: cuts the chunks of these stored activities again, from their rows as they now are. */
export const rechunkCrmActivities = (database: CacheDatabase, ids: readonly number[], at: number): void => {
  if (!ids.length) return
  const chunk = crmActivityChunkWriter(database)
  const released: string[] = []
  for (const row of database
    .prepare(
      `SELECT ${COLUMNS} FROM records r JOIN accounts a ON a.id = r.account_id
        WHERE r.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)))
    for (const hash of chunk(chunkedOf(row), at)?.released ?? []) released.push(hash)
  dropUnusedVectors(database, released)
}

const BACKFILL = 200
const EMBEDDED_SQL =
  "length(trim(coalesce(json_extract(r.fields, '$.subject'), '') || coalesce(json_extract(r.fields, '$.body'), ''), " +
  `' ' || char(9, 10, 13))) >= ${SHORTEST_EMBEDDED_ACTIVITY}`

/**
 * Drops the chunks of activities deleted or gone, then cuts the chunks of live activities that have none: those
 * saved before activities were searched by meaning. Short write transactions, `until` asked before each, so a
 * deadline stops it with `left`; nothing under a read-only store.
 */
export const refreshCrmActivityChunks = (
  database: CacheDatabase,
  now: number,
  until: () => boolean = () => false,
): { dropped: number; added: number; left: boolean } => {
  if (isQueryOnly(database)) return { dropped: 0, added: 0, left: false }
  const dropped = write(database, () => {
    const gone = database
      .prepare(
        `DELETE FROM chunks WHERE chunkable_type = '${CRM_ACTIVITY_CHUNK}' AND NOT EXISTS (SELECT 1 FROM records r
          WHERE r.id = chunkable_id AND r.type = '${ACTIVITY_RECORD}' AND r.deleted_at IS NULL)
          RETURNING content_hash AS hash`,
      )
      .all()
      .map(({ hash }) => String(hash))
    dropUnusedVectors(database, gone)
    return gone.length
  })
  const chunk = crmActivityChunkWriter(database)
  // An activity too short to embed never gets a chunk: reading it again at every embed would find nothing.
  const page = database.prepare(
    `SELECT ${COLUMNS} FROM records r JOIN accounts a ON a.id = r.account_id
      WHERE r.id > ? AND r.type = '${ACTIVITY_RECORD}' AND r.deleted_at IS NULL AND ${EMBEDDED_SQL}
        AND NOT EXISTS (SELECT 1 FROM chunks k
          WHERE k.chunkable_type = '${CRM_ACTIVITY_CHUNK}' AND k.chunkable_id = r.id)
      ORDER BY r.id LIMIT ?`,
  )
  let added = 0
  let after = 0
  for (;;) {
    if (until()) return { dropped, added, left: page.all(after, 1).length > 0 }
    const rows = write(database, () => {
      const found = page.all(after, BACKFILL)
      for (const row of found) if (chunk(chunkedOf(row), now)) added += 1
      return found
    })
    const last = rows.at(-1)
    if (!last || rows.length < BACKFILL) break
    after = Number(last.id)
  }
  return { dropped, added, left: false }
}

const LIVE =
  `k.chunkable_type = '${CRM_ACTIVITY_CHUNK}' AND EXISTS (SELECT 1 FROM records r WHERE r.id = k.chunkable_id ` +
  `AND r.type = '${ACTIVITY_RECORD}' AND r.deleted_at IS NULL)`

const UNEMBEDDED = `${LIVE} AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)`

export const crmActivityChunksLeft = (database: CacheDatabase, model: string): number =>
  Number(
    database.prepare(`SELECT count(DISTINCT k.content_hash) AS n FROM chunks k WHERE ${UNEMBEDDED}`).get(model)?.n ?? 0,
  )

/**
 * Live activities' chunks with no vector of `model`, by hash from `after`, each with its text cut again. A chunk
 * whose text no longer hashes to its hash was cut from older text: its activity is cut again (never under a
 * read-only store) and the chunk left out, so no vector is made of other text than its hash names.
 */
export const crmActivityChunksToEmbed = (
  database: CacheDatabase,
  model: string,
  { after, limit }: { after?: string; limit: number },
  now: number = Date.now(),
): { hash: string; text: string }[] => {
  const activity = database.prepare(
    `SELECT ${COLUMNS} FROM records r JOIN accounts a ON a.id = r.account_id WHERE r.id = ?`,
  )
  const stale: number[] = []
  const found = database
    .prepare(
      `SELECT k.content_hash AS hash, min(k.chunkable_id) AS owner, k.start_offset AS start, k.end_offset AS end
         FROM chunks k WHERE k.content_hash > ? AND ${UNEMBEDDED}
        GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
    )
    .all(after ?? "", model, limit)
    .flatMap((row) => {
      const owner = activity.get(Number(row.owner))
      if (!owner) return []
      const { subject, body, id } = chunkedOf(owner)
      const text = textOf(subject, body).slice(Number(row.start), Number(row.end))
      if (chunkHash(text) === String(row.hash)) return [{ hash: String(row.hash), text }]
      stale.push(id)
      return []
    })
  if (stale.length && !isQueryOnly(database)) write(database, () => rechunkCrmActivities(database, stale, now))
  return found
}

export const crmActivitiesEmbedded = (database: CacheDatabase, model: string, accountIds: readonly number[]): boolean =>
  accountIds.length > 0 &&
  database
    .prepare(
      `SELECT 1 FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
        WHERE ${LIVE} AND k.account_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .get(model, JSON.stringify(accountIds)) !== undefined

/** One deal or lead an activity found by meaning is on, with that activity's text. */
export interface CrmActivityNearest {
  account: AccountKey
  /** The store's `deal:<id>` or `lead:<id>`. */
  ref: string
  kind: DealKind
  subject: string
  body: string | null
  score: number
}

const SCAN_PAGE = 5_000

interface Best {
  owner: number
  chunk: number
  score: number
}

const ranked = (best: Map<number, Best>, limit: number) =>
  [...best.values()].sort((a, b) => b.score - a.score || a.owner - b.owner).slice(0, limit)

/**
 * The deals and leads of one account whose activities are nearest to `query` by their best chunk's vector of
 * `model`, best first, each with its nearest activity. An activity counts only through a live deal or lead of `kinds`
 * the viewer may read (SEC-197): one on contacts or companies alone, or on a hidden deal, is never found, and a hidden
 * deal is never named. By the model's vector index, or by a scan of the account's chunks while it has none.
 */
export const nearestCrmActivities = (
  database: CacheDatabase,
  model: string,
  query: Float32Array,
  {
    account,
    accountId,
    limit,
    kinds = DEAL_KINDS,
    viewers = [],
  }: {
    account: AccountKey
    accountId: number
    limit: number
    kinds?: readonly DealKind[]
    viewers?: readonly CopyViewer[]
  },
): CrmActivityNearest[] => {
  const rules = viewers
    .filter((one) => one.account.provider === account.provider && one.account.account === account.account)
    .map((one) => viewerSql("d", one))
  const targetsOf = kinds.map((kind) => ({
    kind,
    read: database.prepare(
      `SELECT d.id FROM record_relations rr JOIN ${TABLES[kind]} d ON d.account_id = ?
          AND d.external_id = rr.target_external_id AND d.deleted_at IS NULL
          ${rules.map(({ sql }) => `AND ${sql}`).join(" ")}
        WHERE rr.record_id = ? AND rr.role = 'on' AND rr.target_type = '${kind}' ORDER BY d.id`,
    ),
    params: rules.flatMap(({ params }) => params),
  }))
  const targets = new Map<number, { kind: DealKind; id: number }[]>()
  const targetsOfActivity = (owner: number) => {
    let found = targets.get(owner)
    if (found === undefined) {
      found = targetsOf.flatMap(({ kind, read, params }) =>
        read.all(accountId, ...params, owner).map((row) => ({ kind, id: Number(row.id) })),
      )
      targets.set(owner, found)
    }
    return found
  }
  const columns = `k.id, k.chunkable_id AS owner, k.content_hash AS hash, v.vector
    FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
    WHERE ${LIVE} AND k.account_id = ?`
  const keep = (best: Map<number, Best>, row: Record<string, unknown>) => {
    const owner = Number(row.owner)
    if (!targetsOfActivity(owner).length) return
    const score = dot(query, row.vector as Uint8Array)
    if (score > (best.get(owner)?.score ?? Number.NEGATIVE_INFINITY))
      best.set(owner, { owner, chunk: Number(row.id), score })
  }
  const candidates = database.prepare(`SELECT ${columns} AND k.id IN (SELECT value FROM json_each(?)) ORDER BY k.id`)
  const activities =
    searchIndex(database, model, { kind: CRM_ACTIVITY_CHUNK, account: accountId }, query, limit, (near) => {
      const hashes = new Map(near.map(({ id, hash }) => [id, hash]))
      const best = new Map<number, Best>()
      for (const row of candidates.all(model, accountId, JSON.stringify([...hashes.keys()])))
        if (hashes.get(Number(row.id)) === row.hash) keep(best, row)
      const results = ranked(best, limit)
      return { results, best: results.map(({ chunk }) => chunk) }
    }) ??
    (() => {
      const page = database.prepare(`SELECT ${columns} AND k.id > ? ORDER BY k.id LIMIT ?`)
      const best = new Map<number, Best>()
      let after = 0
      for (;;) {
        const rows = page.all(model, accountId, after, SCAN_PAGE)
        for (const row of rows) keep(best, row)
        const last = rows.at(-1)
        if (!last || rows.length < SCAN_PAGE) break
        after = Number(last.id)
      }
      return ranked(best, limit)
    })()
  const text = database.prepare(
    "SELECT json_extract(fields, '$.subject') AS subject, json_extract(fields, '$.body') AS body FROM records " +
      "WHERE id = ?",
  )
  // Several activities on one deal: the deal is found once, by its nearest.
  const named = new Set<string>()
  return activities.flatMap(({ owner, score }) => {
    const row = text.get(owner)
    return targetsOfActivity(owner).flatMap(({ kind, id }) => {
      const ref = `${kind}:${id}`
      if (named.has(ref)) return []
      named.add(ref)
      return [
        {
          account,
          ref,
          kind,
          subject: row?.subject == null ? "" : String(row.subject),
          body: row?.body == null ? null : String(row.body),
          score,
        },
      ]
    })
  })
}

/** Activities and tasks by meaning: each saved activity's subject and text are cut into chunks, embedded later. */
export interface CrmActivityChunks {
  /** Drops the chunks of activities gone, then cuts those of activities saved before they were searched by meaning. */
  refresh(options?: { until?: () => boolean }): Promise<{ dropped: number; added: number; left: boolean }>
  /** Live activities' chunks with no vector of `model`, by hash from `after`, with their text. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<{ hash: string; text: string }[]>
  /** How many chunks `chunksToEmbed` would still give, at most. */
  chunksLeft(model: string): Promise<number>
  /** Whether a live activity of these accounts, or of any when none are named, has a vector of `model`. */
  embedded(model: string, accounts?: readonly AccountKey[]): Promise<boolean>
  /**
   * The deals and leads of these accounts whose activities are nearest in meaning to `query`, best first, each with its
   * nearest activity; only through a deal or lead of `kinds` every viewer may read. Vectors are unit length.
   */
  nearest(
    model: string,
    query: Float32Array,
    options: {
      limit: number
      /** Every account holding activities when left out. */
      accounts?: readonly AccountKey[]
      kinds?: readonly DealKind[]
      viewers?: readonly CopyViewer[]
    },
  ): Promise<CrmActivityNearest[]>
}

export const crmActivityChunksOver = (context: StoreContext): CrmActivityChunks => {
  const { database, now } = context
  const accountsOf = (accounts: readonly AccountKey[] | undefined): { id: number; key: AccountKey }[] =>
    accounts === undefined
      ? database
          .prepare(
            "SELECT a.id, a.provider, a.external_id AS account FROM accounts a WHERE a.id IN " +
              `(SELECT DISTINCT account_id FROM chunks WHERE chunkable_type = '${CRM_ACTIVITY_CHUNK}')`,
          )
          .all()
          .map((row) => ({ id: Number(row.id), key: { provider: String(row.provider), account: String(row.account) } }))
      : accounts.flatMap((one) => {
          const id = findAccountPk(context, one)
          return id === undefined ? [] : [{ id, key: { provider: one.provider, account: one.account } }]
        })
  return {
    refresh: async ({ until } = {}) => refreshCrmActivityChunks(database, now(), until),
    chunksToEmbed: async (model, options) => crmActivityChunksToEmbed(database, model, options, now()),
    chunksLeft: async (model) => crmActivityChunksLeft(database, model),
    embedded: async (model, accounts) =>
      crmActivitiesEmbedded(
        database,
        model,
        accountsOf(accounts).map(({ id }) => id),
      ),
    nearest: async (model, query, { limit, accounts, kinds, viewers }) =>
      accountsOf(accounts)
        .flatMap(({ id, key }) =>
          nearestCrmActivities(database, model, query, {
            account: key,
            accountId: id,
            limit,
            ...(kinds === undefined ? {} : { kinds }),
            ...(viewers === undefined ? {} : { viewers }),
          }),
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, limit),
  }
}
