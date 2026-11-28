import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import type { CacheDatabase } from "./driver.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { proposerOf } from "./sqlite/actors.js"
import { MANIFEST } from "./sqlite/manifest.js"
import { rollBack } from "./sqlite/rollback-copy.js"
import { type AccountKey, openStore } from "./store.js"

const MAIL: AccountKey = { provider: "email", account: "me@acme.example.com" }
const NOW = Date.parse("2026-11-28T12:00:00Z")
const OLD_BOTS = ["memo-scan", "memo-mcp", "memo-findings", "memo-mail-findings", "memo-reader", "memo-scanner"]

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

/** A store at version 78 with mail in memo's boxes, memo's bots and a client row of memo's. */
const storeAt78 = async () => {
  const dir = mkdtempSync(join(tmpdir(), "version-79-"))
  const path = join(dir, "store.db")
  const store = await openStore({ path })
  await store.accounts.saveAccount(MAIL, { name: null })
  const accountId = (await store.accounts.storedAccount(MAIL)).id
  await store.mail.saveThread({
    accountId,
    externalId: "t1",
    now: NOW,
    emails: [
      {
        externalId: "<sale@shop.example>",
        subject: "Sale",
        from: { address: "deals@shop.example", name: "Shop" },
        to: [{ address: MAIL.account, name: "Me" }],
        sentAt: NOW,
        receivedAt: NOW,
        bodyText: "Everything must go",
        mailboxes: [
          { externalId: "memo:bulk", name: "bulk", kind: "bulk" },
          { externalId: "memo:envelope:domain:shop.example", name: "envelope: domain shop.example", kind: "envelope" },
          { externalId: "memorial:bulk", name: "memorial", kind: "label" },
        ],
      },
    ],
  })
  await store.close()
  const old = await openCache(path)
  rollBackTo(old, 79)
  const bot = old.prepare("INSERT INTO bots (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id")
  const bots = Object.fromEntries(
    OLD_BOTS.map((name) => [name, Number(bot.get(name, name === "memo-scan" ? "rule" : "agent", NOW, NOW)?.id)]),
  )
  old
    .prepare(
      "INSERT INTO mail_sort_rules (scope, value, over_addresses, past, author, decided_by, created_at, updated_at) " +
        "VALUES ('domain', 'shop.example', 0, 1, 'program', 'memo-mcp', ?, ?), " +
        "('address', 'news@shop.example', 0, 1, 'program', 'memo-scanner', ?, ?)",
    )
    .run(NOW, NOW, NOW, NOW)
  old
    .prepare(
      "INSERT INTO templates (key, channel, language, body, updated_at, updated_by) " +
        "VALUES ('digest', 'mail', 'en', 'Hi', ?, 'memo'), ('reply', 'mail', 'en', 'Thanks', ?, 'mail')",
    )
    .run(NOW, NOW)
  old
    .prepare(
      "INSERT INTO templates_history (key, channel, language, body, saved_at, saved_by, replaced_at) " +
        "VALUES ('digest', 'mail', 'en', 'Hello', ?, 'memo', ?)",
    )
    .run(NOW, NOW)
  return { dir, path, old, accountId, bots }
}

const clients = (database: CacheDatabase, value: { command: string }[]) =>
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES ('clients', ?, ?)")
    .run(
      JSON.stringify(value.map((one) => ({ version: "1.0.0", core: "2.0.0", speaks: 78, seenAt: NOW, ...one }))),
      NOW,
    )

const commandsOf = (database: CacheDatabase) =>
  (
    JSON.parse(String(database.prepare("SELECT value FROM store_settings WHERE key = 'clients'").get()?.value)) as {
      command: string
    }[]
  ).map(({ command }) => command)

it("renames memo's mailboxes, bots, rule deciders, client and templates to the wcat names, and nothing near them", async () => {
  const { path, old, accountId, bots } = await storeAt78()
  clients(old, [{ command: "memo" }, { command: "mail" }])
  old.close()

  const store = await openStore({ path })
  handles.push(store)
  const after = await openCache(path)
  handles.push(after)

  expect(
    after
      .prepare("SELECT external_id FROM mailboxes ORDER BY id")
      .all()
      .map((row) => row.external_id),
  ).toEqual(["wcat:bulk", "wcat:envelope:domain:shop.example", "memorial:bulk"])
  expect(await store.mail.emailRefs({ accountId, mailbox: "wcat:bulk" })).toHaveLength(1)
  expect(await store.mail.emailRefs({ accountId, mailbox: "wcat:envelope:domain:shop.example" })).toHaveLength(1)
  expect(
    after.prepare("SELECT id, name FROM bots WHERE kind <> 'script' AND name <> 'agent' ORDER BY id").all(),
  ).toEqual([
    { id: bots["memo-scan"], name: "wcat-scan" },
    { id: bots["memo-mcp"], name: "wcat-mcp" },
    { id: bots["memo-findings"], name: "wcat-findings" },
    { id: bots["memo-mail-findings"], name: "wcat-mail-findings" },
    { id: bots["memo-reader"], name: "files-reader" },
    { id: bots["memo-scanner"], name: "memo-scanner" },
  ])
  expect(proposerOf(after, "agent", bots["memo-scan"])).toMatchObject({ name: "wcat-scan", kind: "rule" })
  expect(after.prepare("SELECT decided_by FROM mail_sort_rules ORDER BY id").all()).toEqual([
    { decided_by: "wcat-mcp" },
    { decided_by: "memo-scanner" },
  ])
  expect(commandsOf(after)).toEqual(["wcat", "mail"])
  expect(after.prepare("SELECT key, updated_by FROM templates ORDER BY key").all()).toEqual([
    { key: "digest", updated_by: "wcat" },
    { key: "reply", updated_by: "mail" },
  ])
  expect(after.prepare("SELECT saved_by FROM templates_history").get()?.saved_by).toBe("wcat")
  expect(after.prepare("SELECT max(min_compatible) AS n FROM schema_migrations").get()?.n).toBe(79)
})

it("names no `memo upgrade` in the notice wcat prints when it moves the store", async () => {
  const { old } = await storeAt78()
  clients(old, [{ command: "memo" }, { command: "mail" }])

  const notice = migrate(old, { command: "wcat", version: "1.0.0" })
  old.close()

  expect(notice).toContain("`mail upgrade`")
  expect(notice).not.toContain("memo")
})

it("drops memo's client row when wcat already has one", async () => {
  const { path, old } = await storeAt78()
  clients(old, [{ command: "memo" }, { command: "wcat" }, { command: "tg" }])
  old.close()

  handles.push(await openStore({ path }))
  const after = await openCache(path)
  handles.push(after)

  expect(commandsOf(after)).toEqual(["wcat", "tg"])
})

it("still opens a store where the new names are taken, and leaves the old rows beside them", async () => {
  const { path, old, accountId } = await storeAt78()
  old
    .prepare(
      "INSERT INTO mailboxes (account_id, external_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(accountId, "wcat:bulk", "bulk", "bulk", NOW, NOW)
  old.prepare("INSERT INTO bots (name, kind, created_at, updated_at) VALUES ('wcat-scan', 'rule', ?, ?)").run(NOW, NOW)
  old.close()

  handles.push(await openStore({ path }))
  const after = await openCache(path)
  handles.push(after)

  expect(
    after
      .prepare("SELECT external_id FROM mailboxes WHERE external_id LIKE '%bulk' ORDER BY external_id")
      .all()
      .map((row) => row.external_id),
  ).toEqual(["memo:bulk", "memorial:bulk", "wcat:bulk"])
  expect(
    after
      .prepare("SELECT name FROM bots WHERE name IN ('memo-scan', 'wcat-scan') ORDER BY name")
      .all()
      .map((row) => row.name),
  ).toEqual(["memo-scan", "wcat-scan"])
  expect(after.prepare("SELECT max(version) AS n FROM schema_migrations").get()?.n).toBe(79)
})

it("takes a rollback copy of the tables it rewrites first, and goes back to memo's names from it", async () => {
  const { dir, path, old } = await storeAt78()
  old.close()

  handles.push(await openStore({ path }))
  const [copy] = readdirSync(join(dir, "backups"))
  expect(copy).toMatch(/^store-rollback-schema-78-\d{4}-\d{2}-\d{2}T.*\.db$/)
  const saved = await openCache(join(dir, "backups", String(copy)))
  const tables = JSON.parse(String(saved.prepare("SELECT value FROM rollback_meta WHERE key = 'tables'").get()?.value))
  saved.close()
  expect(tables).toEqual(expect.arrayContaining(MANIFEST.find(({ version }) => version === 79)?.tables ?? []))
  await handles.pop()?.close()

  const database = await openCache(path)
  handles.push(database)
  const back = rollBack(database, join(dir, "backups", String(copy)))
  expect(back.foreignKeyViolations).toBe(0)
  expect(database.prepare("SELECT max(version) AS n FROM schema_migrations").get()?.n).toBe(78)
  expect(database.prepare("SELECT 1 FROM mailboxes WHERE external_id = 'memo:bulk'").get()).toBeDefined()
  expect(database.prepare("SELECT 1 FROM bots WHERE name = 'memo-scan'").get()).toBeDefined()
  expect(database.prepare("SELECT updated_by FROM templates WHERE key = 'digest'").get()?.updated_by).toBe("memo")
})
