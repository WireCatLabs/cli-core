import type { CacheDatabase } from "../driver.js"

/** Where an IMAP server holds an email: `folder` is the mailbox's external id. */
export interface EmailLocationInput {
  folder: string
  uidvalidity: string
  uid: number
}

/** One email of a folder as a sync sees it there. */
export interface FolderEmail {
  uid: number
  externalId: string
  receivedAt: number | null
  read: boolean | null
  flagged: boolean | null
  /** Its locations in every folder, and the folders it is a member of: an email is gone only when all are lost. */
  locations: number
  folders: number
}

export const locate = (database: CacheDatabase, accountId: number, emailId: number, where: EmailLocationInput) =>
  database
    .prepare(
      `INSERT OR REPLACE INTO email_locations (mailbox_id, uidvalidity, uid, email_id)
         SELECT id, ?, ?, ? FROM mailboxes WHERE account_id = ? AND external_id = ?`,
    )
    .run(where.uidvalidity, where.uid, emailId, accountId, where.folder)

export const folderEmails = (
  database: CacheDatabase,
  accountId: number,
  folder: string,
  uidvalidity: string,
): FolderEmail[] =>
  database
    .prepare(
      `SELECT l.uid, e.external_id, coalesce(e.received_at, e.sent_at) AS at, e.read, e.flagged,
         (SELECT count(*) FROM email_locations x WHERE x.email_id = e.id) AS locations,
         (SELECT count(*) FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
           WHERE m.email_id = e.id AND b.kind IS NULL) AS folders
       FROM email_locations l JOIN emails e ON e.id = l.email_id
       WHERE l.mailbox_id = (SELECT id FROM mailboxes WHERE account_id = ? AND external_id = ?)
         AND l.uidvalidity = ? AND e.deleted_at IS NULL
       ORDER BY l.uid`,
    )
    .all(accountId, folder, uidvalidity)
    .map((row) => ({
      uid: Number(row.uid),
      externalId: String(row.external_id),
      receivedAt: row.at === null ? null : Number(row.at),
      read: row.read === null ? null : Boolean(row.read),
      flagged: row.flagged === null ? null : Boolean(row.flagged),
      locations: Number(row.locations),
      folders: Number(row.folders),
    }))

export const setLocations = (
  database: CacheDatabase,
  accountId: number,
  folder: string,
  uidvalidity: string,
  found: ReadonlyMap<string, number[]>,
): number => {
  database
    .prepare(
      `DELETE FROM email_locations WHERE uidvalidity <> ?
         AND mailbox_id = (SELECT id FROM mailboxes WHERE account_id = ? AND external_id = ?)`,
    )
    .run(uidvalidity, accountId, folder)
  const lookup = database.prepare("SELECT id FROM emails WHERE account_id = ? AND external_id = ?")
  let count = 0
  for (const [externalId, uids] of found) {
    const row = lookup.get(accountId, externalId)
    if (!row) continue
    for (const uid of uids) locate(database, accountId, Number(row.id), { folder, uidvalidity, uid })
    count++
  }
  return count
}

export const forgetLocations = (
  database: CacheDatabase,
  accountId: number,
  folder: string,
  uidvalidity: string,
  uids: number[],
): void => {
  const box = database
    .prepare("SELECT id FROM mailboxes WHERE account_id = ? AND external_id = ?")
    .get(accountId, folder)
  if (!box) return
  const emails = database
    .prepare(
      `DELETE FROM email_locations WHERE mailbox_id = ? AND uidvalidity = ?
         AND uid IN (SELECT value FROM json_each(?)) RETURNING email_id`,
    )
    .all(Number(box.id), uidvalidity, JSON.stringify(uids))
    .map((row) => Number(row.email_id))
  const leave = database.prepare(
    `DELETE FROM email_mailboxes WHERE email_id = ? AND mailbox_id = ?
       AND NOT EXISTS (SELECT 1 FROM email_locations WHERE email_id = ? AND mailbox_id = ?)`,
  )
  for (const emailId of new Set(emails)) leave.run(emailId, Number(box.id), emailId, Number(box.id))
}
