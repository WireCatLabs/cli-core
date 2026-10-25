import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { vectorIndexCounts } from "./sqlite/vector-index.js"
import { openStore } from "./store.js"

it("**indexes the vectors a store held before version 34**, and keeps the index in step after", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-34-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 33), now: () => 1000 })
  const id = (sql: string, ...values: (string | number | Uint8Array)[]) => Number(old.prepare(sql).get(...values)?.id)
  const account = id(
    "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('example', 'a', 1, 1) RETURNING id",
  )
  const chat = id(
    "INSERT INTO chats (account_id, external_id, kind, created_at, updated_at) VALUES (?, 'c', 'group', 1, 1) RETURNING id",
    account,
  )
  const vector = new Uint8Array(new Float32Array([0.6, 0.8]).buffer)
  for (const n of [1, 2, 3]) {
    const message = id(
      `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'x', 'fixture', 1, 1) RETURNING id`,
      chat,
      account,
      `m${n}`,
      n,
    )
    old
      .prepare(
        `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES ('message', ?, 0, 0, 1, ?, ?, ?, 1, 1)`,
      )
      .run(message, `h${n}`, account, n)
    old
      .prepare(
        "INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at) VALUES ('m:x:2', ?, 2, ?, 1, 1)",
      )
      .run(`h${n}`, vector)
  }
  old.close()

  await (await openStore({ path })).close()

  const database = await openCache(path)
  expect(vectorIndexCounts(database)).toEqual([{ model: "m:x:2", dims: 2, ready: true, indexed: 3, expected: 3 }])
  database.prepare("DELETE FROM embeddings WHERE content_hash = 'h2'").run()
  expect(vectorIndexCounts(database)[0]).toMatchObject({ indexed: 2, expected: 2 })
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 34").get()).toEqual({
    min_compatible: 34,
  })
  database.close()
})
