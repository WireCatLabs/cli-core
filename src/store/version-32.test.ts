import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const seedAt31 = async (path: string) => {
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 31), now: () => 1000 })
  const account = old.prepare(
    "INSERT INTO accounts (provider, external_id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 1000) RETURNING id",
  )
  const vault = Number(account.get("folder", "01VAULT", "Vault", '{"format":"obsidian"}')?.id)
  const plain = Number(account.get("folder", "01PLAIN", "Plain", '{"format":"markdown"}')?.id)
  const drive = Number(account.get("folder", "01DRIVE", "google-drive:owner-1", '{"format":"markdown"}')?.id)
  const document = old.prepare(
    "INSERT INTO documents (account_id, external_id, kind, title, file_name, content_hash, front_matter, body, url, " +
      "metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000) RETURNING id",
  )
  const ids = {
    nested: Number(
      document.get(vault, "Projects/Alpha/Spec.md", "file", "Spec", "Spec.md", "h1", '{"tags":["a"]}', "x", null, null)
        ?.id,
    ),
    top: Number(document.get(plain, "Ünïcode.md", "file", "Top", "Ünïcode.md", "h2", null, "y", null, null)?.id),
    child: Number(
      document.get(
        drive,
        "file-1.md",
        "file",
        "Plan",
        null,
        null,
        '{"source":"google-drive","fileId":"file-1","sourceUrl":"https://docs.google.com/document/d/file-1","modifiedAt":"2026-10-01T00:00:00.000Z","sourceVersion":"7"}',
        "z",
        null,
        '{"catalog":{"name":"Plan","parents":["folder-1.md"],"active":true}}',
      )?.id,
    ),
    folder: Number(
      document.get(
        drive,
        "folder-1.md",
        "folder",
        "Team",
        null,
        null,
        '{"source":"google-drive","fileId":"folder-1"}',
        null,
        null,
        '{"catalog":{"name":"Team","parents":[],"active":true}}',
      )?.id,
    ),
  }
  old
    .prepare("INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES (?, ?, 1000, 1000)")
    .run("email", "alice@example.com")
  old.close()
  return { vault, plain, drive, ids }
}

it("**a store from before version 32 keeps every document** and gains one files row each, folders and paths", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-32-")), "wirecat.db")
  const { vault, plain, drive, ids } = await seedAt31(path)

  const store = await openStore({ path })
  await store.close()

  const database = await openCache(path)
  const providers = database.prepare("SELECT id, provider FROM accounts ORDER BY id").all()
  expect(providers).toEqual([
    { id: vault, provider: "obsidian" },
    { id: plain, provider: "local" },
    { id: drive, provider: "folder" },
  ])
  expect(
    database
      .prepare("SELECT id FROM documents ORDER BY id")
      .all()
      .map(({ id }) => id),
  ).toEqual(Object.values(ids).sort((a, b) => a - b))
  const files = database
    .prepare(
      "SELECT f.account_id, f.external_id, f.kind, f.name, f.path, f.path_folded, f.document_id, p.path AS parent, " +
        "f.url, f.external_updated_at, f.metadata FROM files f LEFT JOIN files p ON p.id = f.parent_id ORDER BY f.account_id, f.path",
    )
    .all()
  expect(files).toEqual([
    expect.objectContaining({
      account_id: vault,
      external_id: "Projects",
      kind: "folder",
      parent: null,
      document_id: null,
    }),
    expect.objectContaining({ account_id: vault, external_id: "Projects/Alpha", kind: "folder", parent: "Projects" }),
    expect.objectContaining({
      account_id: vault,
      external_id: "Projects/Alpha/Spec.md",
      name: "Spec.md",
      path_folded: "projects/alpha/spec.md",
      parent: "Projects/Alpha",
      document_id: ids.nested,
      metadata: '{"front_matter":{"tags":["a"]}}',
    }),
    expect.objectContaining({ account_id: plain, path: "Ünïcode.md", path_folded: "unicode.md", document_id: ids.top }),
    expect.objectContaining({ account_id: drive, external_id: "folder-1", kind: "folder", path: "Team", parent: null }),
    expect.objectContaining({
      account_id: drive,
      external_id: "file-1",
      path: "Team/Plan",
      parent: "Team",
      document_id: ids.child,
      url: "https://docs.google.com/document/d/file-1",
      external_updated_at: Date.parse("2026-10-01T00:00:00.000Z"),
      metadata: '{"version":"7"}',
    }),
  ])
  expect(database.prepare("SELECT email FROM identities WHERE provider = 'email'").get()).toEqual({
    email: "alice@example.com",
  })
  expect(database.prepare("SELECT count(*) AS n FROM store_settings WHERE key = 'files_backfill_after'").get()).toEqual(
    {
      n: 0,
    },
  )
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 32").get()).toEqual({
    min_compatible: 32,
  })
  database.close()
})

it("refuses the upgraded file to a build of version 31, which still reads folder accounts as `folder`", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-32-")), "wirecat.db")
  await seedAt31(path)
  await (await openStore({ path })).close()
  const database = await openCache(path)
  expect(() => migrate(database, { migrations: MIGRATIONS.filter(({ version }) => version <= 31) })).toThrow(
    /upgrade this tool/,
  )
  database.close()
})
