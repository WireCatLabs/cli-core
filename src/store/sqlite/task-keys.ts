import { createHash } from "node:crypto"
import type { TaskKind } from "../../tasks/index.js"
import type { CacheDatabase } from "../driver.js"

/** A task found in a message is keyed by its type, not its inbox: `Q-15`, `REQ-22`, `M-7`, `PR-4`. */
export const TASK_KEY_PREFIXES: Readonly<Record<TaskKind, string>> = {
  question: "Q",
  request: "REQ",
  mention: "M",
  promise: "PR",
}

/**
 * The next free key of a type, from its counter row, inside the caller's write. A key an owner project already
 * holds (a project keyed `REQ` made before keys were typed) is passed over, since keys are unique across projects.
 */
export const typedKey = (database: CacheDatabase, kind: TaskKind): string => {
  const prefix = TASK_KEY_PREFIXES[kind]
  const next = database.prepare(
    "INSERT INTO task_key_counters (prefix, tasks_count) VALUES (?, 1) " +
      "ON CONFLICT (prefix) DO UPDATE SET tasks_count = tasks_count + 1 RETURNING tasks_count",
  )
  const taken = database.prepare("SELECT 1 FROM tasks WHERE key = ?")
  for (;;) {
    const key = `${prefix}-${Number(next.get(prefix)?.tasks_count)}`
    if (!taken.get(key)) return key
  }
}

/** One inbox project per task account (`telegram:100`): derived from the account text alone, no `-` in it. */
export const INBOX_KEY_LENGTH = 10
export const inboxKey = (account: string): string =>
  `IN${createHash("sha256").update(account).digest("hex").slice(0, 8).toUpperCase()}`

/** An inbox made before its messenger saved the account learns it here, not only on its next task. */
export const linkInbox = (database: CacheDatabase, account: string, accountId: number): void => {
  database
    .prepare("UPDATE projects SET account_id = ? WHERE key = ? AND account_id IS NULL")
    .run(accountId, inboxKey(account))
}

/** The task account (`provider:account`) a task row belongs to: its inbox project's name. */
export const taskAccountOf = (database: CacheDatabase, rowId: number): string | undefined => {
  const row = database
    .prepare("SELECT p.key, p.name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?")
    .get(rowId)
  // Only an inbox project speaks for an account: a project the owner named `telegram:500` does not.
  return row && String(row.key) === inboxKey(String(row.name)) ? String(row.name) : undefined
}
