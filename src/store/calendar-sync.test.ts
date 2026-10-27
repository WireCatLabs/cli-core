import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"
import { calendarSyncContract } from "../calendar/testing/index.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("sync engine over the SQLite event store", () => {
  for (const { name, run } of calendarSyncContract(async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "calendar-sync-")), "store.db") })
    opened.push(store)
    const accountId = await store.accounts.saveAccount(
      { provider: "google-calendar", account: "owner-1" },
      { name: null },
    )
    return { store: store.calendar, accountId }
  }))
    it(name, run)
})
