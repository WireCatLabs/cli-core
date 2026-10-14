import { CliError } from "@wirecat/cli-base"
import {
  analyzerIdentity,
  createStemmer,
  DEFAULT_STEMMERS,
  DEFAULT_STEMMERS_VERSION,
  SNOWBALL_VERSION,
} from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import {
  claim,
  INDEX,
  nextQueued,
  type StemsFill,
  savedStemmers,
  saveStoreStemmers,
  stemmersOrigin,
  stemsState,
  stemWriter,
  storeStemmers,
} from "./stems.js"
import { writeBatch } from "./transaction.js"

/**
 * Brings the stems towards "ready" in short write transactions: the messages up to the watermark, then
 * the queue. One stemmer per run, so its cache serves every batch. Never rebuilds: a row built by other
 * choices is left for `store migrate` or `store reindex`.
 */
export const fillStems = (
  database: CacheDatabase,
  {
    batch = 5_000,
    until = () => false,
    onBatch,
    now = Date.now,
  }: { batch?: number; until?: () => boolean; onBatch?: (step: string, done: number) => void; now?: () => number } = {},
): StemsFill => {
  const filled: StemsFill = { stemmed: 0, drained: 0 }
  const before = stemsState(database)
  // Every search asks; when all is built, or the row waits for a rebuild, it must not take the write lock.
  const stemmers = storeStemmers(database)
  if (!before || before.ready || before.cause !== "building" || !stemmers) return filled
  const identity = analyzerIdentity(stemmers)
  const stemmer = createStemmer(stemmers)
  const writer = stemWriter(database, stemmer)
  const advance = database.prepare("UPDATE search_index_state SET filled_through = ? WHERE name = ?")
  for (;;) {
    const state = stemsState(database)
    if (!state || state.filledThrough >= state.watermark || until()) break
    const to = Math.min(state.filledThrough + batch, state.watermark)
    const done = writeBatch(database, () => {
      if (!claim(database, identity)) return undefined
      const count = writer.range(state.filledThrough, to)
      advance.run(to, INDEX)
      return count
    })
    if (done === undefined) return filled
    filled.stemmed += done
    onBatch?.("stemmed", filled.stemmed)
  }
  for (;;) {
    if (until()) break
    const done = writeBatch(database, () => {
      const pks = nextQueued(database, batch)
      return pks.length === 0 || !claim(database, identity) ? 0 : writer.queued(pks)
    })
    if (done === 0) break
    filled.drained += done
    onBatch?.("drained", filled.drained)
  }
  const state = stemsState(database)
  if (state && state.filledThrough >= state.watermark && state.builtAt === null && state.built === identity) {
    database.prepare("UPDATE search_index_state SET built_at = ? WHERE name = ?").run(now(), INDEX)
  }
  return filled
}

const snowballOf = (identity: string): number[] =>
  (/^snowball-(\d+)\.(\d+)\.(\d+)/.exec(identity)?.slice(1) ?? []).map(Number)

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * Empties the stems and starts them again from the newest message, claimed by the store's setting —
 * for `store reindex`, and for `store migrate` when the stems were built by other choices. A row built
 * by a newer Snowball than this binary has is refused: rebuilding it would downgrade every newer tool.
 */
export const resetStems = (
  database: CacheDatabase,
  { force = false, now = Date.now }: { force?: boolean; now?: () => number } = {},
): boolean => {
  const state = stemsState(database)
  if (!state) return false
  if (!force && state.cause !== "stemmer_changed" && state.cause !== "stemmer_unknown") return false
  if (state.cause === "stemmer_unknown") {
    throw new CliError(
      "validation_error",
      "the store asks for stemmers this tool does not know — upgrade this tool, or choose again with config set search_stemmers.*",
      { reason: "stemmer.unknown" },
    )
  }
  if (state.built !== null && newer(snowballOf(state.built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) {
    throw new CliError(
      "validation_error",
      `the stems were built by Snowball ${snowballOf(state.built).join(".")}, newer than this tool's ${SNOWBALL_VERSION} — upgrade this tool`,
      { reason: "stemmer.newer", built: state.built, wanted: state.wanted },
    )
  }
  writeBatch(database, () => {
    // Saved, not defaulted: an older tool with another default then refuses as "unknown" instead of
    // rebuilding the stems back to its own choice on its next reindex.
    if (savedStemmers(database) === undefined) saveStoreStemmers(database, DEFAULT_STEMMERS, now(), "default")
    database.exec(`INSERT INTO ${INDEX} (${INDEX}) VALUES ('delete-all')`)
    database.exec("DELETE FROM message_stems_pending")
    database
      .prepare(
        `UPDATE search_index_state SET watermark = (SELECT coalesce(max(id), 0) FROM messages),
           filled_through = 0, built_at = NULL, analyzer = ? WHERE name = ?`,
      )
      .run(state.wanted, INDEX)
  })
  return true
}

/**
 * Stems an older tool built with its own default, while nobody chose stemmers, start again with this
 * build's default: nobody chose the old one, so it waits for no `store reindex`. Like a first fill
 * from then on. A saved default is replaced only by newer defaults, so two versions never rebuild each
 * other's. A row a newer Snowball built is left for an upgrade.
 */
export const followDefaultStemmers = (database: CacheDatabase, now: () => number = Date.now): boolean => {
  const saved = stemmersOrigin(database)
  if (saved?.origin === "owner") return false
  if (saved?.origin === "default") {
    if (saved.defaults >= DEFAULT_STEMMERS_VERSION || savedStemmers(database) === null) return false
    const built = stemsState(database)?.built
    if (built && newer(snowballOf(built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) return false
    saveStoreStemmers(database, DEFAULT_STEMMERS, now(), "default")
  }
  const state = stemsState(database)
  if (state?.cause !== "stemmer_changed" || state.built === null) return false
  if (newer(snowballOf(state.built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) return false
  return resetStems(database, { now })
}
