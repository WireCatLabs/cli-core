import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, MENTION_QUERY, type MessageStore, openStore } from "./store.js"

const OWN: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "telegram", account: "2" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "separation-")), "store.db") })
  opened.push(store)
  return store
}

const owner = { method: "manual", by: "owner" }
const uidOf = async (store: MessageStore, provider: string, id: string) =>
  (await store.people.personOf({ provider, id }))?.uid

describe("an owner's separation", () => {
  it("is not undone when an account's own identity joins the owner", async () => {
    const store = await open()
    await store.people.savePeople(OWN, [{ id: "1", name: "Slava" }])
    await store.accounts.saveAccount(OWN, { name: null })
    await store.people.savePeople(OTHER, [
      { id: "2", name: "Slava" },
      { id: "5", name: "Slava P" },
    ])
    await store.people.linkToOwner({ provider: "telegram", id: "5" })
    await store.people.unlinkIdentity({ provider: "telegram", id: "5" }, owner)
    await store.people.linkIdentities({ provider: "telegram", id: "2" }, { provider: "telegram", id: "5" }, owner)

    await store.accounts.saveAccount(OTHER, { name: null })

    const me = await store.people.owner()
    expect(me?.identities.map(({ provider, id }) => `${provider}:${id}`)).toEqual(["max:1"])
    expect(await uidOf(store, "telegram", "2")).toBe(await uidOf(store, "telegram", "5"))
  })

  it("refuses an agent's link of an identity back to the person the owner moved it from", async () => {
    const store = await open()
    await store.people.savePeople(OWN, [{ id: "7", name: "Ana" }])
    const ana = await uidOf(store, "max", "7")
    await store.messages.saveMessages(
      OWN,
      "-1",
      [
        {
          id: "1",
          chatId: "-1",
          senderId: "7",
          senderName: "Ana",
          timestamp: "2026-10-01T10:00:00.000Z",
          editedAt: null,
          text: "+7 900 000-00-01",
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        },
      ],
      { via: "history" },
    )
    const [phone] = (
      await store.mentions.mentions(OWN, parseLucene("kind:phone", { ...MENTION_QUERY, defaultField: "value" }), {
        offset: 0,
      })
    ).items
    await store.mentions.confirmMention(OWN, phone?.id ?? 0, `person:${ana}`, { by: "owner" })
    await store.people.unlinkIdentity({ provider: "phone", id: "+79000000001" }, owner)

    await expect(
      store.mentions.confirmMention(OWN, phone?.id ?? 0, `person:${ana}`, { by: "agent" }),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "identity.separated" } })
    expect(await uidOf(store, "phone", "+79000000001")).not.toBe(ana)

    await store.mentions.confirmMention(OWN, phone?.id ?? 0, `person:${ana}`, { by: "owner" })
    expect(await uidOf(store, "phone", "+79000000001")).toBe(ana)
  })
})
