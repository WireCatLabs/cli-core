import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "./store.js"

const owner = { provider: "whatsapp", account: "1@lid" }

const message = (id: string, outgoing: boolean, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "7@lid",
  senderId: outgoing ? "1@lid" : "7@lid",
  senderName: null,
  timestamp: "2026-10-22T10:00:00.000Z",
  editedAt: null,
  text: "Lunch at one?",
  outgoing,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setUp = async (...messages: Message[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "delivery-")), "wirecat.db") })
  opened.push(store)
  await store.messages.saveMessages(owner, "7@lid", messages, { via: "history" })
  return store
}

const deliveryOf = async (store: MessageStore, id: string) =>
  (await store.messages.message(owner, id, { chatId: "7@lid" }))?.delivery

it("a receipt moves the owner's message forward and a late delivered never moves it back", async () => {
  const store = await setUp(message("A1", true))
  expect(await deliveryOf(store, "A1")).toBeUndefined()

  expect(await store.messages.saveDelivery(owner, "7@lid", "A1", "delivered")).toBe(true)
  expect(await deliveryOf(store, "A1")).toBe("delivered")

  await store.messages.saveDelivery(owner, "7@lid", "A1", "read")
  await store.messages.saveDelivery(owner, "7@lid", "A1", "delivered")
  expect(await deliveryOf(store, "A1")).toBe("read")
})

it("keeps no receipt for someone else's message or one the store does not hold", async () => {
  const store = await setUp(message("B1", false))

  expect(await store.messages.saveDelivery(owner, "7@lid", "B1", "read")).toBe(false)
  expect(await store.messages.saveDelivery(owner, "7@lid", "missing", "read")).toBe(false)
  expect(await store.messages.saveDelivery(owner, "nobody@lid", "B1", "read")).toBe(false)
  expect(await deliveryOf(store, "B1")).toBeUndefined()
})

it("a saved message's own state raises the stored one, and a save without one keeps it", async () => {
  const store = await setUp(message("C1", true, { delivery: "delivered" }))
  expect(await deliveryOf(store, "C1")).toBe("delivered")

  await store.messages.saveMessages(owner, "7@lid", [message("C1", true, { delivery: "read" })], { via: "history" })
  await store.messages.saveMessages(owner, "7@lid", [message("C1", true)], { via: "live" })
  await store.messages.saveMessages(owner, "7@lid", [message("C1", true, { delivery: "delivered" })], {
    via: "history",
  })

  expect(await deliveryOf(store, "C1")).toBe("read")
})
