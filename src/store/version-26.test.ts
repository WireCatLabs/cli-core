import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 26 keeps its reaction totals** and takes people's reactions after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-26-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1" }
  const store = await openStore({ path })
  await store.messages.saveMessages(
    owner,
    "7",
    [
      {
        id: "40",
        chatId: "7",
        senderId: "9",
        senderName: "Olga",
        timestamp: "2026-10-01T10:00:00.000Z",
        editedAt: null,
        text: "Lunch?",
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: { counts: [{ reaction: "👍", count: 2 }], mine: null, total: 2 },
      },
    ],
    { via: "history" },
  )
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 26)
  database.close()

  const upgraded = await openStore({ path })
  expect((await upgraded.messages.message(owner, "40", { chatId: "7" }))?.reactions?.total).toBe(2)
  await upgraded.messages.saveReaction(owner, "7", "40", {
    person: { id: "1", name: "Me", username: null },
    own: true,
    reaction: "❤️",
    reactedAt: "2026-10-01T10:01:00.000Z",
  })
  expect((await upgraded.messages.message(owner, "40", { chatId: "7" }))?.reactions).toEqual({
    counts: [{ reaction: "❤️", count: 1 }],
    mine: "❤️",
    total: 1,
  })
  await upgraded.close()
})
