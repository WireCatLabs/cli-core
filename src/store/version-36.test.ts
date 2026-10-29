import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const owner = { provider: "telegram", account: "500" }

const card = { name: "Ana Ruiz", firstName: "Ana", lastName: "Ruiz", phone: "+34600123456", userId: "42" }

const shared = (attachments: Message["attachments"]): Message => ({
  id: "1",
  chatId: "7",
  senderId: "7",
  senderName: null,
  timestamp: "2026-10-29T10:00:00.000Z",
  editedAt: null,
  text: "",
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

it("**a store from before version 36 gains attachments.contact** and keeps its attachments", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-36-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 35), now: () => 1000 })
  old.close()

  const store = await openStore({ path })
  const database = await openCache(path)
  expect(database.prepare("SELECT name FROM pragma_table_info('attachments') WHERE name = 'contact'").all()).toEqual([
    { name: "contact" },
  ])
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 36").get()).toEqual({
    min_compatible: 34,
  })
  database.close()
  await store.close()
})

it("keeps a contact card whole, and a later copy without the card does not erase it", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "version-36-")), "wirecat.db") })
  await store.messages.saveMessages(owner, "7", [shared([{ kind: "contact", name: "Ana Ruiz", contact: card }])], {
    via: "history",
  })
  await store.messages.saveMessages(owner, "7", [shared([{ kind: "contact", name: "Ana Ruiz" }])], { via: "history" })

  const [attachment] = (await store.messages.message(owner, "1", { chatId: "7" }))?.attachments ?? []

  expect(attachment).toMatchObject({ kind: "contact", contact: card })
  await store.close()
})
