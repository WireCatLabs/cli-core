import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openStore } from "./store.js"

it("authorizes a person only through identity links seen in explicitly allowed accounts", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "person-scope-example-")), "store.db") })
  try {
    const a = { provider: "example", account: "alice-example" },
      b = { provider: "example", account: "bob-sample" }
    const account = await store.accounts.saveAccount(a, { name: "Alice Example" })
    const foreign = await store.accounts.saveAccount(b, { name: "Bob Sample" })
    await store.people.savePeople(a, [{ id: "alice", name: "Alice Example" }])
    const uid = (await store.people.personOf({ provider: "example", id: "alice" }))?.uid
    if (!uid) throw new Error("Missing invented person")
    expect(await store.people.personSeenInAccounts(uid, [account])).toBe(true)
    expect(await store.people.personSeenInAccounts(uid, [foreign])).toBe(false)
    expect(await store.people.personSeenInAccounts("999999", [account])).toBe(false)
    for (const ids of [[], [0], [Number.MAX_SAFE_INTEGER + 1], Array(1001).fill(account)])
      await expect(store.people.personSeenInAccounts(uid, ids)).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.people.personSeenInAccounts("0", [account])).rejects.toMatchObject({ code: "validation_error" })
  } finally {
    await store.close()
  }
})
