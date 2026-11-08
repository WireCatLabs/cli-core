import type { CacheDatabase } from "../driver.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

/** Which template: `report/morning-digest`, `telegram`, `ru`. */
export interface TemplateAddress {
  key: string
  channel: string
  language: string
}

export interface StoredTemplate extends TemplateAddress {
  body: string
  updatedAt: number
  updatedBy: string
}

/** A body a save or a reset replaced. */
export interface TemplateHistoryEntry extends TemplateAddress {
  id: number
  body: string
  savedAt: number
  savedBy: string
  replacedAt: number
}

/** The owner's templates over the shipped ones. Nothing here checks a body: the caller does, before `save`. */
export interface TemplateStore {
  list(): StoredTemplate[]
  get(address: TemplateAddress): StoredTemplate | undefined
  /** Stores `body`, and keeps the body it replaces in the history. */
  save(address: TemplateAddress, body: string, by: string): StoredTemplate
  /** Deletes the stored body, kept in the history, so the shipped one applies; false when there was none. */
  reset(address: TemplateAddress): boolean
  /** Newest first. */
  history(address: TemplateAddress, limit?: number): TemplateHistoryEntry[]
}

interface Row {
  key: string
  channel: string
  language: string
  body: string
  updated_at: number
  updated_by: string
}

const templateOf = (row: Row): StoredTemplate => ({
  key: row.key,
  channel: row.channel,
  language: row.language,
  body: row.body,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
})

const WHERE = "key = ? AND channel = ? AND language = ?"
const at = ({ key, channel, language }: TemplateAddress) => [key, channel, language] as const

export const templateStoreOver = ({ database, now }: StoreContext): TemplateStore => {
  const get = (address: TemplateAddress) => {
    const row = database.prepare(`SELECT * FROM templates WHERE ${WHERE}`).get(...at(address)) as Row | undefined
    return row && templateOf(row)
  }
  const keep = (old: StoredTemplate, replacedAt: number) =>
    database
      .prepare(
        "INSERT INTO templates_history (key, channel, language, body, saved_at, saved_by, replaced_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...at(old), old.body, old.updatedAt, old.updatedBy, replacedAt)

  return {
    list: () =>
      (database.prepare("SELECT * FROM templates ORDER BY key, channel, language").all() as unknown as Row[]).map(
        templateOf,
      ),
    get,
    save: (address, body, by) =>
      write(database, () => {
        const time = now()
        const old = get(address)
        if (old) keep(old, time)
        database
          .prepare(
            "INSERT INTO templates (key, channel, language, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT (key, channel, language) DO UPDATE SET body = excluded.body, " +
              "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
          )
          .run(...at(address), body, time, by)
        return { ...address, body, updatedAt: time, updatedBy: by }
      }),
    reset: (address) =>
      write(database, () => {
        const old = get(address)
        if (!old) return false
        keep(old, now())
        database.prepare(`DELETE FROM templates WHERE ${WHERE}`).run(...at(address))
        return true
      }),
    history: (address, limit = 20) =>
      (
        database
          .prepare(`SELECT * FROM templates_history WHERE ${WHERE} ORDER BY id DESC LIMIT ?`)
          .all(...at(address), limit) as unknown as (Omit<Row, "updated_at" | "updated_by"> & {
          id: number
          saved_at: number
          saved_by: string
          replaced_at: number
        })[]
      ).map((row) => ({
        id: row.id,
        key: row.key,
        channel: row.channel,
        language: row.language,
        body: row.body,
        savedAt: row.saved_at,
        savedBy: row.saved_by,
        replacedAt: row.replaced_at,
      })),
  }
}

/**
 * The stored bodies of one key and language, by channel, read without migrating the file: a store older than the
 * table has none.
 */
export const storedTemplateBodies = (
  database: CacheDatabase,
  key: string,
  language: string,
): Record<string, string> => {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'templates'").get()) return {}
  const rows = database
    .prepare("SELECT channel, body FROM templates WHERE key = ? AND language = ?")
    .all(key, language) as unknown as { channel: string; body: string }[]
  return Object.fromEntries(rows.map((row) => [row.channel, row.body]))
}
