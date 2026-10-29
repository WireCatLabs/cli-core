import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { openStore } from "./store.js"

it("gives the owner person, with who is linked to them, and nothing when none is marked", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "owner-")), "store.db")
  const store = await openStore({ path })
  try {
    await store.people.savePeople({ provider: "telegram", account: "2" }, [{ id: "5", name: "Viacheslav" }])
    const linked = await store.people.linkToOwner({ provider: "telegram", id: "5" })
    const owner = await store.people.owner()
    expect(owner?.uid).toBe(linked.uid)
    expect(owner?.identities).toContainEqual(expect.objectContaining({ provider: "telegram", id: "5" }))

    const raw = new DatabaseSync(path)
    raw.exec("UPDATE persons SET owner = 0")
    raw.close()
    expect(await store.people.owner()).toBeUndefined()
  } finally {
    await store.close()
  }
})
