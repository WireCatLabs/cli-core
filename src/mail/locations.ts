import type { FolderEmail, MessageStore } from "../store/index.js"
import type { Quick, Searched } from "./source.js"

/** The flags a listing shows that differ from the stored ones, by Message-ID, for mail whose UID is stored. */
export const flagsToRefresh = (
  rows: ReadonlyMap<string, FolderEmail>,
  listing: readonly Quick[],
): Map<string, { read?: boolean; flagged?: boolean }> => {
  const changes = new Map<string, { read?: boolean; flagged?: boolean }>()
  for (const { uid, seen, flagged } of listing) {
    const row = rows.get(uid)
    if (row === undefined) continue
    const changed = {
      ...(seen === undefined || seen === row.read ? {} : { read: seen }),
      ...(flagged === undefined || flagged === row.flagged ? {} : { flagged }),
    }
    if (Object.keys(changed).length) changes.set(row.externalId, changed)
  }
  return changes
}

export interface LocationProof {
  /** Each folder listed by UID: what the server searched, and the stored mail with a UID there, before this run saved. */
  folders: ReadonlyMap<string, { searched: Searched; rows: readonly FolderEmail[] }>
  /** Mail received before this is outside the window IMAP's SINCE can vouch for. */
  windowFrom: number
  /** Messages this run saw in any folder: one moved to another folder is not gone. */
  present: ReadonlySet<string>
  now: number
}

/**
 * A folder listed by UID proves a deletion from the UIDs it stores: mail in the window whose UID the server no
 * longer lists is gone from that folder, and gone altogether when no other location of it is left. Nothing is
 * changed when too many would go, as for a header listing.
 */
export const proveByLocation = async (
  store: MessageStore,
  accountId: number,
  { folders, windowFrom, present, now }: LocationProof,
  refuse: (gone: number, candidates: number) => string | undefined,
): Promise<{ deleted: number; skipped?: string }> => {
  const candidates = new Set<string>()
  const lost = new Map<string, { row: FolderEmail; locations: number; folders: Set<string> }>()
  const lostUids = new Map<string, number[]>()
  for (const [folder, { searched, rows }] of folders) {
    const inWindow = new Set(searched.uids.map(Number))
    for (const row of rows) {
      if (row.receivedAt === null || row.receivedAt < windowFrom) continue
      candidates.add(row.externalId)
      if (inWindow.has(row.uid)) continue
      const entry = lost.get(row.externalId) ?? { row, locations: 0, folders: new Set<string>() }
      entry.locations++
      entry.folders.add(folder)
      lost.set(row.externalId, entry)
      const uids = lostUids.get(folder) ?? []
      uids.push(row.uid)
      lostUids.set(folder, uids)
    }
  }
  const gone = [...lost]
    .filter(
      ([id, entry]) =>
        !present.has(id) && entry.locations === entry.row.locations && entry.folders.size >= entry.row.folders,
    )
    .map(([id]) => id)
  const refused = refuse(gone.length, candidates.size)
  if (refused) return { deleted: 0, skipped: refused }
  // Marked first: an interruption leaves locations that prove it again, never an email with no way to be found.
  const deleted = gone.length ? await store.mail.markDeleted(accountId, gone, now) : 0
  for (const [folder, uids] of lostUids)
    await store.mail.forgetLocations(
      accountId,
      folder,
      (folders.get(folder) as { searched: Searched }).searched.validity as string,
      uids,
    )
  return { deleted }
}
