import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import type { MailFilter } from "./emails.js"
import { page } from "./events.js"
import type { ColumnMap, Where } from "./query-filter.js"

/** A thread list query's columns. `subject:` finds a word or phrase at a word's start, `word*` included. */
export const THREAD_COLUMNS = {
  subject: {
    where: ({ value }) => ({
      sql: "instr(' ' || coalesce(email_threads.subject_folded, lower(email_threads.subject)), ' ' || ?) > 0",
      params: [fold(value).replace(/\*+$/, "")],
    }),
  },
  emails_count: { type: "num", sql: "email_threads.emails_count" },
  last_email_at: { type: "time", sql: "email_threads.last_email_at" },
} as const satisfies ColumnMap

export type ThreadFilter = MailFilter & { where?: Where }

export const threadRows = (database: CacheDatabase, filter: ThreadFilter) => {
  const [limit, offset] = page(filter)
  return database
    .prepare(
      `SELECT * FROM email_threads WHERE (? IS NULL OR account_id = ?) AND (? OR deleted_at IS NULL)
         AND (${filter.where?.sql ?? "1"}) ORDER BY coalesce(last_email_at, 0) DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(
      filter.accountId ?? null,
      filter.accountId ?? null,
      filter.includeDeleted ? 1 : 0,
      ...(filter.where?.params ?? []),
      limit,
      offset,
    )
}
