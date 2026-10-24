import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { EmailInput } from "./sqlite/emails.js"
import { type MessageStore, openStore } from "./store.js"

const drive = { provider: "google-drive", account: "drive-owner-1" }
const mailbox = { provider: "email", account: "owner@example.com" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "same-email-")), "store.db") })
  opened.push(store)
  return store
}

const receiveMail = async (store: MessageStore) => {
  const accountId = await store.accounts.saveAccount(mailbox, { name: "Owner" })
  const email: EmailInput = {
    externalId: "<one@example.com>",
    subject: "Plan",
    from: { address: "Alice@Example.com", name: "Alice Example" },
    to: [{ address: "owner@example.com", name: null }],
    cc: [],
    sentAt: 1000,
    receivedAt: 1100,
    references: [],
    bodyText: "The plan.",
    outgoing: false,
    read: true,
    mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }],
  }
  await store.mail.saveThread({ accountId, externalId: "t1", emails: [email], now: 2000 })
}

const saveEditor = (store: MessageStore, email: string | null = "alice@example.com") =>
  store.people.savePeople(drive, [{ id: "g-1", name: "Alice Example", email }])

const personOf = async (store: MessageStore, provider: string, id: string) =>
  (await store.people.personOf({ provider, id }))?.uid

describe("a provider contact with an address", () => {
  it("joins the person of an earlier mail contact with that exact address", async () => {
    const store = await open()
    await receiveMail(store)
    await saveEditor(store, " ALICE@example.com ")
    expect(await personOf(store, "google-drive", "g-1")).toBe(await personOf(store, "email", "alice@example.com"))
    const link = (await store.people.personOf({ provider: "google-drive", id: "g-1" }))?.identities.find(
      (one) => one.provider === "google-drive",
    )
    expect(link).toMatchObject({ method: "same-email", linkedBy: "google-drive" })
  })

  it("is joined by mail that arrives later, and is no mail correspondent before that", async () => {
    const store = await open()
    await saveEditor(store)
    const before = await store.people.personOf({ provider: "email", id: "alice@example.com" })
    expect(before?.identities.find((one) => one.provider === "email")?.accounts).toEqual([])
    await receiveMail(store)
    expect(await personOf(store, "email", "alice@example.com")).toBe(await personOf(store, "google-drive", "g-1"))
  })

  it("stays apart after the owner unlinks it, through every later save", async () => {
    const store = await open()
    await receiveMail(store)
    await saveEditor(store)
    await store.people.unlinkIdentity({ provider: "google-drive", id: "g-1" }, { method: "manual", by: "owner" })
    await saveEditor(store)
    await receiveMail(store)
    expect(await personOf(store, "google-drive", "g-1")).not.toBe(await personOf(store, "email", "alice@example.com"))
  })

  it("joins nobody by name alone", async () => {
    const store = await open()
    await receiveMail(store)
    await saveEditor(store, null)
    expect(await personOf(store, "google-drive", "g-1")).not.toBe(await personOf(store, "email", "alice@example.com"))
  })
})
