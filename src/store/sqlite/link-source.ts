import type { CacheDatabase } from "../driver.js"

type Row = Record<string, unknown>

/** A relationships read selects its reporter with this, so a page of links costs no lookup per row. */
export const REPORTER_SQL =
  "(SELECT provider || ':' || external_id FROM accounts r WHERE r.id = links.account_id) AS reporter"

/** What a source said about a relationship link: the account that reported it and how it was derived. */
export const sourceOf = (
  database: CacheDatabase,
  row: Row,
  metadata: Record<string, unknown>,
): { account?: string; derived?: string } => {
  const reporter =
    row.account_id == null
      ? undefined
      : "reporter" in row
        ? row.reporter
        : database
            .prepare("SELECT provider || ':' || external_id AS key FROM accounts WHERE id = ?")
            .get(Number(row.account_id))?.key
  return {
    ...(typeof reporter === "string" ? { account: reporter } : {}),
    ...(typeof metadata.derived === "string" ? { derived: metadata.derived } : {}),
  }
}
