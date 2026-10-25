import { FOLDER_PROVIDER, isDocumentAccountProvider } from "../../../domain/providers.js"
import type { CacheDatabase } from "../../driver.js"

type Row = Record<string, unknown>

/** `google-drive:<principal>` names a documents account; anything else is a notes folder's name. */
const documentsKeyOf = (collection: string): { provider: string; account: string } | undefined => {
  const colon = collection.indexOf(":")
  const provider = collection.slice(0, colon)
  return colon > 0 && isDocumentAccountProvider(provider)
    ? { provider, account: collection.slice(colon + 1) }
    : undefined
}

/**
 * The name a transfer gives a collection. A Drive collection is `google-drive:<principal>` before version 31 (the
 * stand-in folder's name) and after it (the account's key), so transfers between stores on either side still match.
 */
export const collectionNameOf = (row: Row): string =>
  row.provider === FOLDER_PROVIDER ? String(row.name) : `${String(row.provider)}:${String(row.external_id)}`

/** At most two rows: the account a collection name stands for, and a second one only when that is ambiguous. */
export const collectionAccounts = (database: CacheDatabase, collection: string): Row[] => {
  const key = documentsKeyOf(collection)
  return key
    ? database
        .prepare(
          "SELECT * FROM accounts WHERE (provider=? AND external_id=?) OR (provider='folder' AND name=?) ORDER BY id LIMIT 2",
        )
        .all(key.provider, key.account, collection)
    : database.prepare("SELECT * FROM accounts WHERE provider='folder' AND name=? ORDER BY id LIMIT 2").all(collection)
}

/** The stand-in folder version 31 moved an account's documents from, as its `settings.movedFrom` records it. */
export const movedFromOf = (row: Row | undefined): { external_id?: unknown } | undefined => {
  if (typeof row?.settings !== "string") return undefined
  try {
    const moved = (JSON.parse(row.settings) as { movedFrom?: unknown }).movedFrom
    return typeof moved === "object" && moved !== null ? (moved as { external_id?: unknown }) : undefined
  } catch {
    return undefined
  }
}

/**
 * A source store from before version 31 holds Drive in a `folder` named `google-drive:<principal>`; the copy gets the
 * shape version 31 gives it, so it lands in (or creates) the `google-drive` account, never a new stand-in folder.
 */
export const currentCollection = (row: Row): Row => {
  const key = row.provider === FOLDER_PROVIDER ? documentsKeyOf(String(row.name)) : undefined
  if (!key) return row
  const settings = (() => {
    try {
      return typeof row.settings === "string" ? (JSON.parse(row.settings) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  })()
  return {
    ...row,
    provider: key.provider,
    external_id: key.account,
    name: "Google Drive",
    settings: JSON.stringify({
      ...settings,
      movedFrom: { id: row.id, external_id: row.external_id, name: row.name },
    }),
  }
}
