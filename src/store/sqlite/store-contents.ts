import type { CacheDatabase } from "../driver.js"

/** The tables `store info` counts; a file from before a table's migration simply lacks it. */
export const COUNTED_TABLES = [
  "accounts",
  "chats",
  "messages",
  "emails",
  "documents",
  "meetings",
  "events",
  "attachments",
  "identities",
] as const

/** Tables whose rows belong to one account, so they can be counted per account and per provider. */
const PER_ACCOUNT = ["chats", "messages", "emails", "documents", "meetings"] as const
type PerAccount = (typeof PER_ACCOUNT)[number]
type Counts = Record<PerAccount, number>

export const hasTable = (database: CacheDatabase, table: string): boolean =>
  database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined

export const rowCounts = (database: CacheDatabase): Partial<Record<(typeof COUNTED_TABLES)[number], number>> =>
  Object.fromEntries(
    COUNTED_TABLES.filter((table) => hasTable(database, table)).map((table) => [
      table,
      Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0),
    ]),
  )

const zero = (): Counts => ({ chats: 0, messages: 0, emails: 0, documents: 0, meetings: 0 })

/**
 * What the store holds, grouped, over every account in it. Plain `count(*) … GROUP BY` on indexed
 * columns only: `dbstat` would give sizes per table but reads every page of the file.
 */
export const storeContents = (database: CacheDatabase) => {
  if (!hasTable(database, "accounts")) return undefined
  const accounts = database.prepare("SELECT id, provider, name FROM accounts ORDER BY provider, id").all()
  const perAccount = new Map(accounts.map((row) => [Number(row.id), zero()]))
  for (const table of PER_ACCOUNT.filter((one) => hasTable(database, one))) {
    for (const row of database.prepare(`SELECT account_id, count(*) AS n FROM ${table} GROUP BY account_id`).all()) {
      const counts = perAccount.get(Number(row.account_id))
      if (counts) counts[table] = Number(row.n)
    }
  }
  const providerOf = new Map(accounts.map((row) => [Number(row.id), String(row.provider)]))

  const byProvider = new Map<string, Counts & { accounts: number }>()
  for (const [account, counts] of perAccount) {
    const provider = providerOf.get(account) as string
    const into = byProvider.get(provider) ?? { accounts: 0, ...zero() }
    into.accounts++
    for (const table of PER_ACCOUNT) into[table] += counts[table]
    byProvider.set(provider, into)
  }

  const byYear = new Map<string, { provider: string; year: number; messages: number }>()
  if (hasTable(database, "messages")) {
    // UTC years: the store keeps `sent_at` as epoch milliseconds and the machine's zone is not the owner's.
    const rows = database
      .prepare(
        `SELECT account_id, CAST(strftime('%Y', sent_at / 1000, 'unixepoch') AS INTEGER) AS year, count(*) AS n
         FROM messages GROUP BY account_id, year`,
      )
      .all()
    for (const row of rows) {
      const provider = providerOf.get(Number(row.account_id)) ?? "unknown"
      const key = `${provider}\u0000${row.year}`
      const into = byYear.get(key) ?? { provider, year: Number(row.year), messages: 0 }
      into.messages += Number(row.n)
      byYear.set(key, into)
    }
  }

  const byChatKind = hasTable(database, "chats")
    ? database
        .prepare(
          `SELECT a.provider, c.kind, count(*) AS chats, coalesce(sum(m.n), 0) AS messages
           FROM chats c
           JOIN accounts a ON a.id = c.account_id
           LEFT JOIN (SELECT chat_id, count(*) AS n FROM messages GROUP BY chat_id) m ON m.chat_id = c.id
           GROUP BY a.provider, c.kind
           ORDER BY a.provider, c.kind`,
        )
        .all()
        .map((row) => ({
          provider: String(row.provider),
          kind: String(row.kind),
          chats: Number(row.chats),
          messages: Number(row.messages),
        }))
    : []

  const byAttachmentKind = hasTable(database, "attachments")
    ? database
        .prepare(
          `SELECT attachable_type, kind, count(*) AS n, coalesce(sum(size), 0) AS bytes
           FROM attachments GROUP BY attachable_type, kind ORDER BY attachable_type, kind`,
        )
        .all()
        .map((row) => ({
          type: String(row.attachable_type),
          kind: String(row.kind),
          count: Number(row.n),
          bytes: Number(row.bytes),
        }))
    : []

  return {
    byProvider: [...byProvider]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, counts]) => ({ provider, ...counts })),
    byChatKind,
    byAccount: accounts.map((row) => ({
      provider: String(row.provider),
      accountId: Number(row.id),
      name: row.name === null ? null : String(row.name),
      ...(perAccount.get(Number(row.id)) as Counts),
    })),
    byYear: [...byYear.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.year - b.year),
    byAttachmentKind,
  }
}
