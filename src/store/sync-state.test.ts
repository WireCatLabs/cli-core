import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "sync-state-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

describe("sync state", () => {
  it("**remembers a value per account and name**, replaces it, and forgets it when cleared", async () => {
    let clock = Date.parse("2026-09-30T10:00:00.000Z")
    const store = await openStore({ path: fresh(), now: () => clock })
    await store.sync.setSyncState(OWNER, "login.marker", "1727690000000")
    clock += 60_000
    await store.sync.setSyncState(OWNER, "login.marker", "1727690060000")
    await store.sync.setSyncState(OTHER, "login.marker", "5")

    expect(await store.sync.syncState(OWNER, "login.marker")).toEqual({
      value: "1727690060000",
      at: "2026-09-30T10:01:00.000Z",
    })
    expect(await store.sync.syncState(OTHER, "login.marker")).toMatchObject({ value: "5" })
    expect(await store.sync.syncState(OWNER, "chats.fetched")).toBeUndefined()

    await store.sync.clearSyncState(OWNER, "login.marker")
    expect(await store.sync.syncState(OWNER, "login.marker")).toBeUndefined()
    expect(await store.sync.syncState(OTHER, "login.marker")).toMatchObject({ value: "5" })
    expect(await store.sync.syncState({ provider: "max", account: "3" }, "login.marker")).toBeUndefined()
    await store.sync.clearSyncState({ provider: "max", account: "3" }, "login.marker")
    await store.close()
  })
})
