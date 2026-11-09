import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const TG = { provider: "telegram", account: "1" }

it("gives a version 60 file's people no address-book tie until contacts sync marks them", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-61-")), "wirecat.db")
  const seeded = await openStore({ path })
  await seeded.people.savePeople(TG, [{ id: "7", name: "Vera" }])
  await seeded.close()
  const old = await openCache(path)
  rollBackTo(old, 61)
  expect(
    old.prepare("SELECT name FROM pragma_table_info('account_identities') WHERE name = 'address_book'").all(),
  ).toEqual([])
  old.close()

  const store = await openStore({ path })
  try {
    expect((await store.people.list({ limit: 10, all: true })).items.find(({ name }) => name === "Vera")?.ties).toEqual(
      [],
    )
    await store.people.saveAddressBook(TG, [{ id: "7", name: "Vera" }])
    expect((await store.people.list({ limit: 10 })).items.find(({ name }) => name === "Vera")?.ties).toEqual([
      "phone-book",
    ])
  } finally {
    await store.close()
  }
})
