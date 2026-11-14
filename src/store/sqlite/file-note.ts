import type { CacheDatabase } from "../driver.js"

const LIVE =
  "f.deleted_at IS NULL AND d.deleted_at IS NULL AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1)=1"

/**
 * The document row of the live file at `path` in an account, shaped as `notes({ folderId })` lists it. A local folder
 * names its files by their own path; any other account by its document's key.
 */
export const fileNoteRow = (
  database: CacheDatabase,
  account: number,
  local: boolean,
  path: string,
): Record<string, unknown> | undefined =>
  database
    .prepare(
      local
        ? "SELECT d.*, f.account_id AS account_id, f.external_id AS external_id, " +
            "coalesce(f.external_updated_at, d.external_updated_at) AS external_updated_at FROM files f " +
            `JOIN documents d ON d.id = f.document_id WHERE f.account_id = ? AND f.external_id = ? AND ${LIVE} ` +
            "ORDER BY d.created_at, d.id LIMIT 1"
        : "SELECT d.*, f.account_id AS account_id, coalesce(f.external_updated_at, d.external_updated_at) AS " +
            "external_updated_at FROM documents d JOIN files f ON f.document_id = d.id AND f.account_id = d.account_id " +
            `WHERE d.account_id = ? AND d.external_id = ? AND ${LIVE} LIMIT 1`,
    )
    .get(account, path)
