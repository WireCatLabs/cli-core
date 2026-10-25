import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const drive = { provider: "google-drive", account: "owner-1" }

const seedAt30 = async (path: string) => {
  const store = await openStore({ path })
  const owner = await store.notes.addFolder({ name: "google-drive:owner-1", format: "markdown" })
  const other = await store.notes.addFolder({ name: "google-drive:owner-2", format: "markdown" })
  const vault = await store.notes.addFolder({ name: "Vault" })
  const lookalike = await store.notes.addFolder({ name: "Google-Drive:owner-3", format: "markdown" })
  const save = (folderId: string, path: string) =>
    store.notes.saveFileNote({ folderId, path, title: path, text: `text of ${path}`, contentHash: path })
  const plan = (await save(owner.id, "file-1.md")).note
  const spec = (await save(other.id, "file-2.md")).note
  const diary = (await save(vault.id, "Diary.md")).note
  await store.accounts.saveAccount(drive, { name: "Google Drive" })
  await store.people.savePeople(drive, [{ id: "101", name: "Rin Synthetic" }])
  await store.accounts.saveProfile("drive", "work", { provider: "folder", account: "google-drive:owner-1" })
  await store.accounts.saveProfile("drive", "home", { provider: "folder", account: "google-drive:owner-2" })
  await store.accounts.saveProfile("tg", "default", { provider: "telegram", account: "100" })
  await store.accounts.saveAccountGroup("docs", [`notes:${owner.id}`, `notes:${vault.id}`, "tg:default"])
  await store.notes.addNote({ text: "Drive of the team", about: [`folder:${owner.id}`] })
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 31)
  database.prepare("UPDATE accounts SET scope = 'work' WHERE id = ?").run(Number(other.id))
  database
    .prepare(
      "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, account_id, created_at, updated_at) " +
        "VALUES ('document', ?, 0, 0, 4, 'c1', 'personal', ?, 1, 1)",
    )
    .run(Number(plan.id), Number(owner.id))
  const duplicate = database
    .prepare(
      "INSERT INTO accounts (provider, external_id, name, settings, created_at, updated_at) " +
        "VALUES ('folder', '01DUPLICATE', 'google-drive:owner-1', '{\"format\":\"markdown\"}', 1, 1) RETURNING id",
    )
    .get()
  database.close()
  return { owner, other, vault, lookalike, duplicate: String(duplicate?.id), plan, spec, diary }
}

it("**moves each principal's Drive documents to its google-drive account** and keeps every id", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-31-")), "wirecat.db")
  const seeded = await seedAt30(path)

  await (await openStore({ path })).close()

  const database = await openCache(path)
  const accountOf = (provider: string, external: string) =>
    database.prepare("SELECT * FROM accounts WHERE provider = ? AND external_id = ?").get(provider, external)
  const first = accountOf("google-drive", "owner-1")
  const second = accountOf("google-drive", "owner-2")
  expect(first).toMatchObject({ name: "Google Drive", scope: "personal" })
  expect(JSON.parse(String(first?.settings))).toEqual({
    format: "markdown",
    movedFrom: { id: Number(seeded.owner.id), external_id: expect.any(String), name: "google-drive:owner-1" },
  })
  expect(second).toMatchObject({ name: "Google Drive", scope: "work" })
  const documents = database.prepare("SELECT id, account_id FROM documents ORDER BY id").all()
  expect(documents).toEqual([
    { id: Number(seeded.plan.id), account_id: first?.id },
    { id: Number(seeded.spec.id), account_id: second?.id },
    { id: Number(seeded.diary.id), account_id: Number(seeded.vault.id) },
  ])
  expect(database.prepare("SELECT account_id FROM chunks WHERE content_hash = 'c1'").get()).toEqual({
    account_id: first?.id,
  })
  expect(
    database.prepare("SELECT count(*) AS people FROM account_identities WHERE account_id = ?").get(Number(first?.id)),
  ).toEqual({ people: 1 })
  expect(
    database
      .prepare("SELECT notable_id FROM notes WHERE notable_type = 'account'")
      .all()
      .map(({ notable_id }) => notable_id),
  ).toEqual([first?.id])
  expect(
    database
      // Version 32 then renames the folders left behind to `local` or `obsidian`; a stand-in keeps `folder`.
      .prepare("SELECT id, name FROM accounts WHERE provider IN ('folder', 'local', 'obsidian') ORDER BY id")
      .all()
      .map(({ id, name }) => [String(id), name]),
  ).toEqual([
    [seeded.vault.id, "Vault"],
    [seeded.lookalike.id, "Google-Drive:owner-3"],
    [seeded.duplicate, "google-drive:owner-1"],
  ])
  const setting = (key: string) =>
    JSON.parse(String(database.prepare("SELECT value FROM store_settings WHERE key = ?").get(key)?.value))
  expect(setting("profiles")).toEqual({
    drive: {
      work: { provider: "google-drive", account: "owner-1" },
      home: { provider: "google-drive", account: "owner-2" },
    },
    tg: { default: { provider: "telegram", account: "100" } },
  })
  expect(setting("accountGroups")).toEqual({
    docs: [`notes:${String(first?.id)}`, `notes:${seeded.vault.id}`, "tg:default"],
  })
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 31").get()).toEqual({
    min_compatible: 31,
  })
  expect(() => migrate(database, { migrations: MIGRATIONS.filter(({ version }) => version <= 30) })).toThrow(
    /written by a newer version/,
  )
  database.close()
})

it("leaves a stand-in folder whose files the google-drive account already holds", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-31-")), "wirecat.db")
  const store = await openStore({ path })
  const folder = await store.notes.addFolder({ name: "google-drive:owner-1", format: "markdown" })
  await store.notes.saveFileNote({ folderId: folder.id, path: "file-1.md", title: "a", text: "a", contentHash: "a" })
  const account = await store.notes.documentsAccount(drive, true)
  await store.notes.saveFileNote({
    folderId: String(account?.id),
    path: "file-1.md",
    title: "b",
    text: "b",
    contentHash: "b",
  })
  await store.close()
  const database = await openCache(path)
  rollBackTo(database, 31)
  database.close()

  await (await openStore({ path })).close()

  const after = await openCache(path)
  expect(after.prepare("SELECT count(*) AS left FROM accounts WHERE id = ?").get(Number(folder.id))).toEqual({
    left: 1,
  })
  expect(after.prepare("SELECT count(*) AS held FROM documents WHERE account_id = ?").get(Number(folder.id))).toEqual({
    held: 1,
  })
  after.close()
})
