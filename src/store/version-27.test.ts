import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 27 keeps its messages** and takes receipts after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-27-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1@lid" }
  const store = await openStore({ path })
  await store.messages.saveMessages(
    owner,
    "7@lid",
    [
      {
        id: "40",
        chatId: "7@lid",
        senderId: "1@lid",
        senderName: "Me",
        timestamp: "2026-10-22T10:00:00.000Z",
        editedAt: null,
        text: "Lunch?",
        outgoing: true,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "history" },
  )
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 27)
  database.close()

  const upgraded = await openStore({ path })
  expect((await upgraded.messages.message(owner, "40", { chatId: "7@lid" }))?.text).toBe("Lunch?")
  await upgraded.messages.saveDelivery(owner, "7@lid", "40", "read")
  expect((await upgraded.messages.message(owner, "40", { chatId: "7@lid" }))?.delivery).toBe("read")
  await upgraded.close()
})
