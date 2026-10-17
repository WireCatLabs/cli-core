import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 20 keeps its messages** and takes poll votes after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-20-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1" }
  const store = await openStore({ path })
  await store.messages.saveMessages(
    owner,
    "7",
    [
      {
        id: "40",
        chatId: "7",
        senderId: "1",
        senderName: "Me",
        timestamp: "2026-10-01T10:00:00.000Z",
        editedAt: null,
        text: "When?",
        outgoing: true,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "send" },
  )
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 20)
  database.close()

  const upgraded = await openStore({ path })
  const vote = {
    person: { id: "9", name: "Olga", username: null },
    answers: ["fri"],
    votedAt: "2026-10-01T10:01:00.000Z",
  }
  await upgraded.messages.saveVote(owner, "7", "40", vote)
  expect((await upgraded.messages.message(owner, "40", { chatId: "7" }))?.text).toBe("When?")
  expect(await upgraded.messages.pollVotes(owner, "7", "40")).toEqual([vote])
  await upgraded.close()
})
