import { CliError } from "@wirecat/cli-base"
import type { AccountKey, StoredHit } from "../types.js"
import type { StoreContext } from "./open.js"
import { hitsByPk } from "./search.js"
import { stemmerCache, stemsState, storeStemmers } from "./stems.js"

const stemmerFor = stemmerCache()

/**
 * For each message, the later messages of the store that share a rare word with it, latest first, at most `limit`
 * each. A word is rare when at most `rareAt` messages hold its stem. A message that cancels or changes a decision
 * often names the same supplier, code or term without replying to it (cli-testing
 * performance/search/evidence-pipeline, "Cancelled decisions and long messages"). Empty while the stems are not
 * built, since their counts would be short.
 */
export const laterSharingRare = (
  context: StoreContext,
  wanted: { account: AccountKey; chatId: string; id: string }[],
  { rareAt, limit }: { rareAt: number; limit: number },
): StoredHit[][] => {
  if (wanted.length > 50 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new CliError("validation_error", "a follow-up lookup takes at most 50 messages and 1–100 results each")
  const { database } = context
  const stemmers = storeStemmers(database)
  if (!wanted.length || !stemmers || !stemsState(database)?.ready) return wanted.map(() => [])
  const stemmer = stemmerFor(stemmers)
  // Counted only up to one past `rareAt`, so a common word costs no more than a rare one. Not an fts5vocab table:
  // creating one is a write, which a read-only connection refuses.
  const count = database.prepare(
    "SELECT count(*) AS doc FROM (SELECT rowid FROM message_stems WHERE message_stems MATCH ? LIMIT ?)",
  )
  const counts = new Map<string, number>()
  const countOf = (stem: string) => {
    let found = counts.get(stem)
    if (found === undefined) {
      found = Number(count.get(`stems : "${stem.replaceAll('"', '""')}"`, rareAt + 1)?.doc ?? 0)
      counts.set(stem, found)
    }
    return found
  }
  const message = database.prepare(`
    SELECT m.text, m.sent_at FROM accounts ac
    JOIN chats c ON c.account_id = ac.id AND c.external_id = ?
    JOIN messages m ON m.chat_id = c.id AND m.external_id = ?
    WHERE ac.provider = ? AND ac.external_id = ? AND m.deleted_at IS NULL
  `)
  const later = database.prepare(`
    SELECT m.id FROM message_stems s JOIN messages m ON m.id = s.rowid
    WHERE message_stems MATCH ? AND m.deleted_at IS NULL AND m.sent_at > ?
    ORDER BY m.sent_at DESC, m.id DESC LIMIT ?
  `)
  return wanted.map(({ account, chatId, id }) => {
    const row = message.get(chatId, id, account.provider, account.account)
    if (!row) return []
    // Words of three letters or more, as the benchmark took them: a number or a code with digits is not a name here.
    const stems = new Set(
      stemmer
        .explain(String(row.text))
        .filter(({ word }) => /^\p{L}{3,}$/u.test(word))
        .map(({ word }) => stemmer.stemToken(word))
        .filter(Boolean),
    )
    const rare = [...stems].filter((stem) => countOf(stem) <= rareAt)
    if (!rare.length) return []
    const match = `stems : (${rare.map((stem) => `"${stem.replaceAll('"', '""')}"`).join(" OR ")})`
    return hitsByPk(
      context,
      later.all(match, Number(row.sent_at), limit).map((one) => Number(one.id)),
    )
  })
}
