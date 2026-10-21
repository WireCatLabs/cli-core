import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const processZone = process.env.TZ
afterEach(() => {
  process.env.TZ = processZone
})

const storedUnder = async (zone: string) => {
  process.env.TZ = zone
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
  const path = join(mkdtempSync(join(tmpdir(), "time-zones-")), "messages.db")
  const store = await openStore({ path, now: () => 5000 })
  try {
    await store.messages.saveMessages(
      { provider: "tg", account: "1" },
      "-1",
      [
        {
          id: "1",
          chatId: "-1",
          senderId: "7",
          senderName: "Person 7",
          timestamp: "2026-10-21T16:03:00+02:00",
          editedAt: "2026-10-21T16:05:00+02:00",
          text: "hello",
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        },
      ],
      { via: "history" },
    )
    await store.facts.add({ type: "fact", statement: "Met", occurredAt: "2026-10-21T16:03:00+02:00", by: "owner" })
  } finally {
    await store.close()
  }
  const database = await openCache(path)
  try {
    return ["messages", "facts"].map((table) =>
      database
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...row })),
    )
  } finally {
    database.close()
  }
}

it("stores the same times whatever zone the process runs in", async () => {
  const east = await storedUnder("Asia/Vladivostok")
  const west = await storedUnder("America/Los_Angeles")
  expect(east).toEqual(west)
  expect(east[0]?.[0]).toMatchObject({ sent_at: Date.parse("2026-10-21T14:03:00Z") })
})
