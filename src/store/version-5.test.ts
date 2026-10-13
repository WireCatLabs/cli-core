import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { searchStore } from "../services/messages.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const account: AccountKey = { provider: "telegram", account: "100" }

it("finds by name a file stored before version 5", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-5-")), "wirecat.db")
  const store = await openStore({ path })
  await store.saveChats(account, [
    { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(
    account,
    "1",
    [
      {
        id: "1",
        chatId: "1",
        senderId: "200",
        senderName: "alice",
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        editedAt: null,
        text: "",
        outgoing: false,
        attachments: [{ kind: "document", name: "Мой отчёт Heron.pdf" }],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "history" },
  )
  await store.close()

  const old = await openCache(path)
  old.exec(`DROP TRIGGER attachment_name_words_ai; DROP TRIGGER attachment_name_words_au;
    DROP TRIGGER attachment_name_words_ad; DROP TABLE attachment_name_words;
    DELETE FROM schema_migrations WHERE version = 5;`)
  old.close()

  const upgraded = await openStore({ path })
  try {
    for (const word of ["heron", "мой", "отчет"]) {
      const found = await searchStore(upgraded, account, { limit: 20, text: word, language: "lucene" })
      expect(found.items.map(({ id }) => id)).toEqual(["1"])
    }
  } finally {
    await upgraded.close()
  }
})
