import type { AccountKey } from "../types.js"

/**
 * A profile that may read only part of one CRM account's copy: the deals and leads assigned to `assignee`,
 * the identity `<account>/user/<id>`, or none when it is `null`.
 */
export interface CopyViewer {
  account: AccountKey
  assignee: string | null
}

/** The condition on a deal or lead row `alias` of the viewer's account, with its parameters. */
export const viewerSql = (alias: string, viewer: CopyViewer | undefined): { sql: string; params: string[] } =>
  viewer === undefined
    ? { sql: "1", params: [] }
    : viewer.assignee === null
      ? { sql: "0", params: [] }
      : { sql: `json_extract(${alias}.metadata, '$.assignee') = ?`, params: [viewer.assignee] }

/** Whether a deal or lead row, with its account's `provider` and `account` and its `assignee`, is the viewer's to read. */
export const seenBy = (viewer: CopyViewer | undefined, row: Record<string, unknown>): boolean =>
  viewer === undefined ||
  row.provider !== viewer.account.provider ||
  row.account !== viewer.account.account ||
  (viewer.assignee !== null && row.assignee === viewer.assignee)
