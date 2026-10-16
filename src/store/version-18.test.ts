import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 18 keeps its mentions** and takes a place after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-18-")), "wirecat.db")
  const store = await openStore({ path })
  const owner = { provider: "max", account: "1" }
  const message: Message = {
    id: "1",
    chatId: "-1",
    senderId: "7",
    senderName: "Ana",
    timestamp: "2026-10-01T10:00:00.000Z",
    editedAt: null,
    text: "Calle Mayor, 12",
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }
  await store.messages.saveMessages(owner, "-1", [message], { via: "history" })
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 18)
  database.close()

  const upgraded = await openStore({ path })
  const [place] = (await upgraded.mentions.mentions(owner, undefined, { offset: 0 })).items
  expect(place).toMatchObject({ kind: "place", status: "found" })
  await upgraded.mentions.confirmMention(owner, place?.id ?? 0, undefined, { by: "owner" })
  expect((await upgraded.mentions.places({ offset: 0 })).items).toHaveLength(1)
  await upgraded.close()
})
