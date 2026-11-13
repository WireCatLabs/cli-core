import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const PHONE = "call me at +34 600 000 001"

/** A store left at `version`, holding one chat message (with a file whose text names a phone) and one mail. */
const storeAt = async (version: number) => {
  const path = join(mkdtempSync(join(tmpdir(), `version-${version}-`)), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter((one) => one.version <= version), now: () => 1000 })
  const id = (sql: string, ...values: (string | number)[]) => Number(old.prepare(sql).get(...values)?.id)
  const account = id(
    "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('example', 'a', 1, 1) RETURNING id",
  )
  const chat = id(
    "INSERT INTO chats (account_id, external_id, kind, created_at, updated_at) VALUES (?, 'c', 'group', 1, 1) RETURNING id",
    account,
  )
  const message = id(
    `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
      VALUES (?, ?, 'm1', 1, ?, 'fixture', 1, 1) RETURNING id`,
    chat,
    account,
    PHONE,
  )
  const attachment = id(
    `INSERT INTO attachments (attachable_type, attachable_id, position, kind, text, created_at, updated_at)
      VALUES ('message', ?, 0, 'file', ?, 1, 1) RETURNING id`,
    message,
    PHONE,
  )
  const thread = id(
    "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, 't1', 1, 1) RETURNING id",
    account,
  )
  const email = id(
    `INSERT INTO emails (account_id, email_thread_id, external_id, created_at, updated_at)
      VALUES (?, ?, 'e1', 1, 1) RETURNING id`,
    account,
    thread,
  )
  old.close()
  await (await openStore({ path })).close()
  return { database: await openCache(path), account, chat, message, attachment, email }
}

const pending = (database: CacheDatabase) =>
  database.prepare("SELECT source_type, source_id FROM mention_pending ORDER BY source_type, source_id").all()

describe("upgrading a store with data across the mention and mail-rule versions (DEBT-345)", () => {
  it("**version 7**: old messages wait for a rebuild, and a message written after the upgrade is queued", async () => {
    const { database, chat, account, message } = await storeAt(6)
    expect(database.prepare("SELECT text FROM messages WHERE id = ?").get(message)).toEqual({ text: PHONE })
    expect(pending(database).filter(({ source_type }) => source_type === "message")).toEqual([])

    const later = Number(
      database
        .prepare(
          `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
            VALUES (?, ?, 'm2', 2, ?, 'fixture', 2, 2) RETURNING id`,
        )
        .get(chat, account, PHONE)?.id,
    )
    expect(pending(database)).toContainEqual({ source_type: "message", source_id: later })
    database.prepare("DELETE FROM messages WHERE id = ?").run(later)
    expect(pending(database)).not.toContainEqual({ source_type: "message", source_id: later })
    database.close()
  })

  it("**version 10**: an old file's text waits for a rebuild, and a new one's is queued", async () => {
    const { database, message, attachment } = await storeAt(9)
    expect(pending(database)).not.toContainEqual({ source_type: "attachment", source_id: attachment })

    database.prepare("UPDATE attachments SET text = ? WHERE id = ?").run(`${PHONE}, or later`, attachment)
    expect(pending(database)).toContainEqual({ source_type: "attachment", source_id: attachment })
    const added = Number(
      database
        .prepare(
          `INSERT INTO attachments (attachable_type, attachable_id, position, kind, text, created_at, updated_at)
            VALUES ('message', ?, 1, 'file', ?, 2, 2) RETURNING id`,
        )
        .get(message, PHONE)?.id,
    )
    expect(pending(database)).toContainEqual({ source_type: "attachment", source_id: added })
    database.close()
  })

  it("**version 12**: an old mail keeps its row with no rule, and a rule is one per account and conditions", async () => {
    const { database, account, email } = await storeAt(11)
    expect(database.prepare("SELECT external_id, mail_rule_id FROM emails WHERE id = ?").get(email)).toEqual({
      external_id: "e1",
      mail_rule_id: null,
    })
    const rule = database.prepare(
      `INSERT INTO mail_rules (account_id, conditions, actions, source, decided_at, created_at, updated_at)
        VALUES (?, '{"from":"news@example.com"}', '["archive"]', 'owner', 1, 1, 1) RETURNING id`,
    )
    const id = Number(rule.get(account)?.id)
    database.prepare("UPDATE emails SET mail_rule_id = ? WHERE id = ?").run(id, email)
    expect(database.prepare("SELECT mail_rule_id FROM emails WHERE id = ?").get(email)).toEqual({ mail_rule_id: id })
    expect(() => rule.get(account)).toThrow(/UNIQUE/)
    database.close()
  })
})
