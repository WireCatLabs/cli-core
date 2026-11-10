import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const TG = { provider: "telegram", account: "1" }

it("gives a version 62 file the triggers that keep chat senders' kinds in step", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-63-")), "wirecat.db")
  const seeded = await openStore({ path })
  await seeded.people.savePeople(TG, [{ id: "7", name: "Vera" }])
  await seeded.chats.saveChats(TG, [
    { id: "g", title: "g", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 40 },
  ])
  await seeded.close()
  const old = await openCache(path)
  rollBackTo(old, 63)
  const triggers = (db: typeof old) =>
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'person_kind_chat_senders_au'").get()?.n
  expect(triggers(old)).toBe(0)
  old.close()

  const store = await openStore({ path })
  const db = await openCache(path)
  try {
    expect(triggers(db)).toBe(1)
    const chat = Number(db.prepare("SELECT id FROM chats WHERE external_id = 'g'").get()?.id)
    const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'telegram'").get()?.id)
    const vera = Number(db.prepare("SELECT id FROM identities WHERE external_id = '7'").get()?.id)
    db.prepare(
      "INSERT INTO messages (chat_id, account_id, external_id, sender_identity_id, sent_at, text, created_at, " +
        "updated_at, source) VALUES (?, ?, 'm', ?, 1, 'hi', 1, 1, 'sync')",
    ).run(chat, account, vera)
    expect(await store.people.counts()).toMatchObject({ stranger: 1 })
    db.prepare("UPDATE chats SET participants_count = 5 WHERE id = ?").run(chat)
    expect(await store.people.counts()).toMatchObject({ person: 2, stranger: 0 })
  } finally {
    db.close()
    await store.close()
  }
})
