import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { searchStore } from "../services/messages-archive-search.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const account = { provider: "telegram", account: "100" }

it("**transcripts stored before version 29 are indexed on upgrade** and found in another form", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-29-")), "wirecat.db")
  const store = await openStore({ path })
  await store.chats.saveChats(account, [
    { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "1",
    [
      {
        id: "1",
        chatId: "1",
        senderId: "200",
        senderName: "alice",
        timestamp: "2026-01-01T10:00:00.000Z",
        editedAt: null,
        text: "",
        outgoing: false,
        attachments: [{ kind: "voice", mime: "audio/ogg" }],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "history" },
  )
  await store.messages.keepTranscript(account, "1", "1", "позвонили риелтору", "gigaam-v3")
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 29)
  expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'transcript_stems'").all()).toEqual([])
  database.close()

  const upgraded = await openStore({ path })
  const found = await searchStore(upgraded, account, { limit: 10, text: "transcript:риелтор" })
  expect(found.items.map(({ id }) => id)).toEqual(["1"])
  await upgraded.close()
})
