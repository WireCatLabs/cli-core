import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { pointerPairs } from "./sqlite/entity-types.js"
import { foreignKeysTo } from "./sqlite/identity-rename.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const BEELINE: AccountKey = { provider: "beeline", account: "office" }
const OLD = "phone:9161234567"
const NEW = "phone:+79161234567"

let store: MessageStore | undefined
let path = ""

const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "identity-rename-")), "wirecat.db")
  store = await openStore({ path })
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const raw = () => new DatabaseSync(path)

const identityId = (db: DatabaseSync, external: string): number | undefined => {
  const row = db.prepare("SELECT id FROM identities WHERE provider = 'beeline' AND external_id = ?").get(external)
  return row ? Number(row.id) : undefined
}

const personOf = (db: DatabaseSync, identity: number) =>
  db.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(identity)?.person_id

type Db = DatabaseSync

/** A row of `table` with every column it needs made up, and the rows its foreign keys need made too. */
const madeUp = (db: Db, table: string, fixed: Record<string, unknown>, salt: number): void => {
  const keys = new Map(
    db
      .prepare('SELECT "from" AS col, "table" AS parent FROM pragma_foreign_key_list(?)')
      .all(table)
      .map((one) => [String(one.col), String(one.parent)]),
  )
  const values: [string, unknown][] = []
  for (const one of db.prepare('SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)').all(table)) {
    const name = String(one.name)
    if (name in fixed) values.push([name, fixed[name]])
    else if (keys.has(name) && Number(one.notnull) === 1) {
      const parent = keys.get(name) as string
      if (!db.prepare(`SELECT 1 FROM "${parent}" WHERE rowid = ?`).get(salt)) madeUp(db, parent, { id: salt }, salt)
      values.push([name, salt])
    } else if (Number(one.notnull) === 1 && one.dflt_value == null && name !== "id")
      values.push([name, String(one.type).toLowerCase() === "text" ? `x${salt}${"id" in fixed ? "p" : ""}` : salt])
  }
  db.prepare(
    `INSERT OR IGNORE INTO "${table}" (${values.map(([name]) => `"${name}"`).join(", ")}) ` +
      `VALUES (${values.map(() => "?").join(", ")})`,
  ).run(...values.map(([, value]) => value as never))
}

/** One row in every table with a foreign key to identities, pointing at `identity`. */
const seedEveryReference = (db: Db, identity: number, salt: number) => {
  const seeded: string[] = []
  for (const { table, column } of foreignKeysTo(db as never, "identities")) {
    if (table === "identity_links") continue
    madeUp(db, table, { [column]: identity }, salt)
    seeded.push(`${table}.${column}`)
  }
  return seeded
}

describe("renameIdentities", () => {
  it("renames an identity the store has only under its old id", async () => {
    const s = await open()
    await s.people.savePeople(BEELINE, [{ id: OLD, name: "Client" }])
    const before = identityId(raw(), OLD)

    const done = await s.people.renameIdentities("beeline", [{ from: OLD, to: NEW }])

    expect(done).toMatchObject({ taken: 1, renamed: 1, merged: 0, untouched: 0, refused: [] })
    const db = raw()
    expect(identityId(db, OLD)).toBeUndefined()
    expect(identityId(db, NEW)).toBe(before)
    expect((await s.people.personOf({ provider: "beeline", id: NEW }))?.name).toBe("Client")
  })

  it("merges the old identity into the new one, every row that points at it with it", async () => {
    const s = await open()
    await s.people.savePeople(BEELINE, [
      { id: OLD, name: "Client", phone: "9161234567" },
      { id: NEW, name: null },
    ])
    let db = raw()
    const [oldId, newId] = [identityId(db, OLD) as number, identityId(db, NEW) as number]
    const oldPerson = personOf(db, oldId)
    db.prepare(
      "INSERT INTO aliases (aliasable_type, aliasable_id, name, name_folded, source, created_at, updated_at) " +
        "VALUES ('identity', ?, 'Ivan', 'ivan', 'owner', 1, 1)",
    ).run(oldId)
    const seeded = seedEveryReference(db, oldId, 1)
    // The same rows for the kept identity: a unique key then holds both, and they fold into one.
    seedEveryReference(db, newId, 1)
    const held = (identity: number) =>
      foreignKeysTo(db as never, "identities")
        .filter(({ table }) => table !== "identity_links")
        .filter(({ table, column }) =>
          Number(db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE "${column}" = ?`).get(identity)?.n),
        )
        .map(({ table, column }) => `${table}.${column}`)
    const before = held(oldId)
    db.close()
    expect(seeded).toHaveLength(21)
    expect(before.length).toBeGreaterThanOrEqual(19)

    const done = await s.people.renameIdentities("beeline", [{ from: OLD, to: NEW }])

    expect(done).toMatchObject({ taken: 1, renamed: 0, merged: 1, untouched: 0, refused: [] })
    db = raw()
    expect(identityId(db, OLD)).toBeUndefined()
    for (const { table, column } of foreignKeysTo(db as never, "identities"))
      expect(db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE "${column}" = ?`).get(oldId)?.n, table).toBe(0)
    for (const { table, pointer } of pointerPairs(db as never))
      expect(
        db
          .prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${pointer}_type = 'identity' AND ${pointer}_id = ?`)
          .get(oldId)?.n,
      ).toBe(0)
    expect(held(newId)).toEqual(expect.arrayContaining(before))
    expect(
      db.prepare("SELECT name AS alias FROM aliases WHERE aliasable_type = 'identity' AND aliasable_id = ?").all(newId),
    ).toEqual([{ alias: "Ivan" }])
    const kept = db.prepare("SELECT name, phone FROM identities WHERE id = ?").get(newId)
    expect(kept).toEqual({ name: "Client", phone: "9161234567" })
    const person = await s.people.personOf({ provider: "beeline", id: NEW })
    expect(person?.identities.map(({ id }) => id)).toEqual([NEW])
    expect(db.prepare("SELECT count(*) AS n FROM identity_links WHERE person_id = ?").get(Number(oldPerson))?.n).toBe(0)
  })

  it("keeps the owner's person when the old identity was the owner's", async () => {
    const s = await open()
    await s.people.savePeople(BEELINE, [
      { id: OLD, name: "Me" },
      { id: NEW, name: "Me too" },
    ])
    const owner = await s.people.owner()
    await s.people.linkToOwner({ provider: "beeline", id: OLD })

    await s.people.renameIdentities("beeline", [{ from: OLD, to: NEW }])

    const person = await s.people.personOf({ provider: "beeline", id: NEW })
    expect(person?.uid).toBe(owner?.uid)
  })

  it("rewrites the identity in the owner's proposals", async () => {
    const s = await open()
    await s.people.savePeople(BEELINE, [{ id: OLD, name: "Client" }])
    await s.people.savePeople({ provider: "telegram", account: "1" }, [{ id: "5", name: "Client" }])
    await s.people.proposeLink({
      identity: { provider: "beeline", id: OLD },
      with: { provider: "telegram", id: "5" },
      signal: "agent",
      by: { bot: "codex" },
    } as never)

    await s.people.renameIdentities("beeline", [{ from: OLD, to: NEW }])

    const payload = String(
      raw().prepare("SELECT payload FROM proposed_actions WHERE kind = 'identity_link'").get()?.payload,
    )
    expect(payload).toContain(`"beeline:${NEW}"`)
    expect(payload).not.toContain(`"beeline:${OLD}"`)
  })

  it("changes nothing the second time", async () => {
    const s = await open()
    await s.people.savePeople(BEELINE, [
      { id: OLD, name: "Client" },
      { id: NEW, name: null },
      { id: "phone:9160000000", name: "Other" },
    ])
    const pairs = [
      { from: OLD, to: NEW },
      { from: "phone:9160000000", to: "phone:+79160000000" },
      { from: "phone:9999999999", to: "phone:+79999999999" },
    ]

    expect(await s.people.renameIdentities("beeline", pairs)).toMatchObject({ renamed: 1, merged: 1, untouched: 1 })
    expect(await s.people.renameIdentities("beeline", pairs)).toMatchObject({
      taken: 3,
      renamed: 0,
      merged: 0,
      untouched: 3,
      refused: [],
    })
  })

  it("stops after the lock time and says how far it got", async () => {
    const s = await open()
    const pairs = Array.from({ length: 3 }, (_, n) => ({ from: `phone:${n}`, to: `phone:+7${n}` }))

    expect((await s.people.renameIdentities("beeline", pairs, { lockMs: 0 })).taken).toBe(1)
  })
})
