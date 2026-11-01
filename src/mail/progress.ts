import { CliError } from "@wirecat/cli-base"
import type { AccountKey, MessageStore } from "../store/index.js"
import { parsePoint, type ResumePoint, resumeKey } from "./resume.js"

export interface MailFolderProgress {
  folder: string
  since: string
  done: number
  total: number
  updatedAt: string
}

/** How far the sync of each stored folder is, from the points the runs saved; the mailbox is not asked. */
export const mailProgress = async (store: MessageStore, key: AccountKey): Promise<MailFolderProgress[]> => {
  let accountId: number
  try {
    accountId = (await store.accounts.storedAccount(key)).id
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return []
    throw error
  }
  const folders: MailFolderProgress[] = []
  for (const { kind, externalId: folder } of await store.mail.mailboxes(accountId)) {
    if (kind !== null) continue
    const point = parsePoint<ResumePoint>((await store.sync.syncState(key, resumeKey(folder)))?.value)
    if (point !== undefined)
      folders.push({
        folder,
        since: point.window.since,
        done: point.window.done,
        total: point.window.total,
        updatedAt: point.updatedAt,
      })
  }
  return folders
}
