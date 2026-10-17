import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { openStore } from "../store.js"
import { saveVote } from "./messages.js"
import { openSqlite } from "./open.js"

it("prepares the vote statements once per store, not once per vote", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "poll-votes-")), "wirecat.db")
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

  const opened = await openSqlite(path)
  const prepared: string[] = []
  const database: CacheDatabase = {
    ...opened.database,
    prepare: (sql) => {
      prepared.push(sql)
      return opened.database.prepare(sql)
    },
  }
  const context = { ...opened, database, now: () => Date.parse("2026-10-01T10:05:00.000Z") }
  const account = Number(opened.database.prepare("SELECT id FROM accounts").get()?.id)
  const chat = Number(opened.database.prepare("SELECT id FROM chats WHERE external_id='7'").get()?.id)
  const vote = (id: string) => ({
    person: { id, name: null, username: null },
    answers: ["fri"],
    votedAt: "2026-10-01T10:01:00.000Z",
  })

  saveVote(context, account, "whatsapp", chat, "40", vote("9"))
  const first = prepared.length
  saveVote(context, account, "whatsapp", chat, "40", vote("10"))
  saveVote(context, account, "whatsapp", chat, "40", vote("11"))

  expect(prepared.filter((sql) => sql.includes("poll_votes"))).toHaveLength(1)
  expect(prepared.length - first).toBe(0)
  expect(Number(opened.database.prepare("SELECT count(*) AS n FROM poll_votes").get()?.n)).toBe(3)
  opened.database.close()
})
