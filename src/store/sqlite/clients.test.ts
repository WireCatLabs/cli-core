import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "../migrations.js"
import { storeClients } from "./clients.js"
import { openSqlite } from "./open.js"

const ours = MIGRATIONS.at(-1)?.version ?? 0
const breaking = [...MIGRATIONS, { version: ours + 1, minCompatible: ours + 1, statements: [] }]

const store = async () => (await openSqlite(join(await mkdtemp(join(tmpdir(), "core-test-clients-")), "s.db"))).database

it("**an upgrade that locks other CLIs out names them and what to run**; the locked-out one names who moved it", async () => {
  const database = await store()
  expect(migrate(database, { command: "memo", version: "0.95.0", now: () => 1 })).toBeUndefined()
  expect(storeClients(database)).toEqual([
    { command: "memo", version: "0.95.0", core: expect.any(String), speaks: ours, seenAt: 1 },
  ])

  expect(migrate(database, { migrations: breaking, command: "tg", version: "0.9.0", now: () => 2 })).toBe(
    `the store moved to schema ${ours + 1}; memo 0.95.0 can no longer open it until upgraded — run \`memo upgrade\``,
  )
  expect(() => migrate(database, { command: "memo", version: "0.95.0" })).toThrow(
    `run \`memo upgrade\` (tg 0.9.0 moved the store to schema ${ours + 1})`,
  )
})

it("says every other CLI needs upgrading when none has recorded itself, and nothing for an additive version", async () => {
  const database = await store()
  migrate(database)
  const additive = [...MIGRATIONS, { version: ours + 1, minCompatible: 1, statements: [] }]
  expect(migrate(database, { migrations: additive, command: "tg", version: "0.9.0" })).toBeUndefined()
  const fresh = await store()
  migrate(fresh)
  expect(migrate(fresh, { migrations: breaking, command: "tg", version: "0.9.0" })).toMatch(
    /every other WireCat CLI that uses it needs a version that speaks it/,
  )
})
