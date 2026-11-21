import type { CacheDatabase, SqlValue } from "../driver.js"
import type { Leaf } from "./lucene-fields.js"

/**
 * Adds a `rarity(id, score)` set for an OR of words: each message scores the sum of log(N/df) over the query words it
 * holds, df counting the messages that hold any form of the word. bm25 weighs every expanded form on its own, so one
 * rare form of a common word ranked like a rare word, and short messages holding it outranked the answer. False when
 * no word reads the word index, so there is nothing to rank by.
 */
export const withRarity = (
  database: CacheDatabase,
  words: string,
  leaves: Leaf[],
  ranked: { sql: string[]; params: SqlValue[] },
) => {
  const matches = [...new Set(leaves.flatMap(({ fragment }) => fragment.fts ?? []))]
  if (!matches.length) return false
  const total = Number(database.prepare(`SELECT count(*) AS n FROM ${words}_docsize`).get()?.n ?? 0)
  const sets = matches.map((fts) => {
    const match = `normalized_text : (${fts})`
    const df = Number(database.prepare(`SELECT count(*) AS n FROM ${words} WHERE ${words} MATCH ?`).get(match)?.n ?? 0)
    ranked.params.push(match)
    return `SELECT rowid AS id, ${df ? Math.log(total / df) : 0} AS w FROM ${words} WHERE ${words} MATCH ?`
  })
  ranked.sql.push(
    `rarity(id, score) AS MATERIALIZED (SELECT id, sum(w) FROM (${sets.join(" UNION ALL ")}) GROUP BY id)`,
  )
  return true
}

/** A fifth of bm25 keeps a message that holds a word many times from ranking only by which words it holds. */
export const RARITY_ORDER = "coalesce(rarity.score, 0) - 0.2 * coalesce(f.rank, 0) DESC, "
