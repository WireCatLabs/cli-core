import {
  analyzerIdentity,
  createStemmer,
  DEFAULT_STEMMERS,
  DEFAULT_STEMMERS_VERSION,
  parseStemmers,
  type Stemmer,
  type Stemmers,
} from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { indexRow } from "./index-state.js"

export const INDEX = "message_stems"
const SETTING = "searchStemmers"

/** Stems a store write leaves for the next fill: an older binary may have left thousands queued. */
export const DRAIN_ON_WRITE = 500

export interface StemsState {
  watermark: number
  filledThrough: number
  /** Messages written or edited since their stems were: queued by triggers, emptied by JS. */
  pending: number
  /** What built the stems; `null` until a fill claims the row. */
  built: string | null
  /** What this binary builds with the store's setting. */
  wanted: string
  /** Every live message is stemmed by `wanted`: stemmed search may run. */
  ready: boolean
  /**
   * Why it is not ready: still filling, built by other choices and waiting for `store reindex`, or the
   * store asks for choices only a newer tool knows.
   */
  cause?: "building" | "stemmer_changed" | "stemmer_unknown"
  builtAt: string | null
}

export interface StemsFill {
  stemmed: number
  drained: number
}

/**
 * The choices `config set search_stemmers.*` saved; `undefined` while the defaults apply, `null` when a
 * newer tool saved one this build does not know. Never throws: every open and write reads it.
 */
export const savedStemmers = (database: CacheDatabase): Stemmers | null | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  if (!row) return undefined
  try {
    return parseStemmers(JSON.parse(String(row.value)))
  } catch {
    return null
  }
}

/** The store-wide choices every fill, drain and readiness check uses; `null` stems nothing. */
export const storeStemmers = (database: CacheDatabase): Stemmers | null => {
  const saved = savedStemmers(database)
  return saved === undefined ? DEFAULT_STEMMERS : saved
}

const UNKNOWN = "unknown to this build"

/**
 * `default` is saved beside the defaults' version; older builds read only `cyrillic` and `latin`, and take
 * any saved value as the owner's choice. A setting without `origin` is the owner's, or a default saved by
 * 0.198–0.199, which cannot be told apart.
 */
export const saveStoreStemmers = (
  database: CacheDatabase,
  stemmers: Stemmers,
  now: number,
  origin: "owner" | "default" = "owner",
): void => {
  const value = {
    ...parseStemmers(stemmers),
    ...(origin === "default" ? { origin, defaults: DEFAULT_STEMMERS_VERSION } : {}),
  }
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(SETTING, JSON.stringify(value), now)
}

/** Who saved the setting: `undefined` when nothing is saved; a default also says which defaults it was. */
export const stemmersOrigin = (
  database: CacheDatabase,
): { origin: "owner" } | { origin: "default"; defaults: number } | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  if (!row) return undefined
  try {
    const value = JSON.parse(String(row.value)) as { origin?: unknown; defaults?: unknown }
    return value.origin === "default"
      ? { origin: "default", defaults: Number(value.defaults) || 0 }
      : { origin: "owner" }
  } catch {
    return { origin: "owner" }
  }
}

/** `undefined` on a file before version 15. */
export const stemsState = (database: CacheDatabase): StemsState | undefined => {
  const row = indexRow(database, INDEX)
  if (!row) return undefined
  const watermark = Number(row.watermark)
  const filledThrough = Number(row.filled_through)
  const pending = Number(database.prepare("SELECT count(*) AS n FROM message_stems_pending").get()?.n)
  const built = row.analyzer === null ? null : String(row.analyzer)
  const stemmers = storeStemmers(database)
  const wanted = stemmers ? analyzerIdentity(stemmers) : UNKNOWN
  // An unclaimed row with nothing to stem is complete: claiming it now would make a first `config set` need a reindex.
  const ready = stemmers !== null && (built === wanted || built === null) && filledThrough >= watermark && pending === 0
  const cause = !stemmers ? "stemmer_unknown" : built !== null && built !== wanted ? "stemmer_changed" : "building"
  return {
    watermark,
    filledThrough,
    pending,
    built,
    wanted,
    ready,
    ...(ready ? {} : { cause }),
    builtAt: row.built_at === null ? null : new Date(Number(row.built_at)).toISOString(),
  }
}

/**
 * Whether this binary may write stems, decided inside the write transaction: an unbuilt row is claimed
 * with its analyzer, a row built by other choices is left alone — so the index never mixes two stemmers.
 */
export const claim = (database: CacheDatabase, identity: string): boolean => {
  const built = indexRow(database, INDEX)?.analyzer
  if (built === undefined) return false
  if (built === null) {
    if (savedStemmers(database) === undefined) saveStoreStemmers(database, DEFAULT_STEMMERS, Date.now(), "default")
    database.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = ?").run(identity, INDEX)
    return true
  }
  return built === identity
}

export const stemWriter = (database: CacheDatabase, stemmer: Stemmer) => {
  const read = database.prepare(
    `SELECT id AS pk, text, 'c' || chat_id || coalesce(' s' || sender_identity_id, '') AS scope
       FROM messages WHERE id > ? AND id <= ?`,
  )
  const one = database.prepare(
    "SELECT text, 'c' || chat_id || coalesce(' s' || sender_identity_id, '') AS scope FROM messages WHERE id = ?",
  )
  const write = database.prepare("INSERT OR REPLACE INTO message_stems (rowid, stems, scope) VALUES (?, ?, ?)")
  const remove = database.prepare("DELETE FROM message_stems WHERE rowid = ?")
  const dequeue = database.prepare("DELETE FROM message_stems_pending WHERE id = ?")
  const restem = (pk: number, row: Record<string, unknown> | undefined) => {
    const stems = row ? stemmer.indexText(String(row.text)) : ""
    if (stems === "") remove.run(pk)
    else write.run(pk, stems, String(row?.scope))
  }
  return {
    range: (from: number, to: number) => {
      const rows = read.all(from, to)
      for (const row of rows) restem(Number(row.pk), row)
      return rows.length
    },
    queued: (pks: number[]) => {
      for (const pk of pks) {
        restem(pk, one.get(pk))
        dequeue.run(pk)
      }
      return pks.length
    },
  }
}

export const nextQueued = (database: CacheDatabase, limit: number): number[] =>
  database
    .prepare("SELECT id AS pk FROM message_stems_pending ORDER BY id LIMIT ?")
    .all(limit)
    .map((row) => Number(row.pk))

/**
 * Stems the messages a store write queued, inside that write's transaction. `stemmerFor` is the store's,
 * so one cache serves every write while the setting stays the same.
 */
export const drainStems = (
  database: CacheDatabase,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  limit = DRAIN_ON_WRITE,
): number => {
  const pks = nextQueued(database, limit)
  if (pks.length === 0) return 0
  const stemmers = storeStemmers(database)
  if (!stemmers) return 0
  const stemmer = stemmerFor(stemmers)
  return claim(database, stemmer.identity) ? stemWriter(database, stemmer).queued(pks) : 0
}

/** Keeps one stemmer while the setting stays the same, and starts a fresh cache when it changes. */
export const stemmerCache = (): ((stemmers: Stemmers) => Stemmer) => {
  let stemmer: Stemmer | undefined
  return (stemmers) => {
    if (stemmer?.identity !== analyzerIdentity(stemmers)) stemmer = createStemmer(stemmers)
    return stemmer
  }
}
