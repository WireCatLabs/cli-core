import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/index.js"
import { mailFolders } from "./folders.js"
import type { MailAccount } from "./sync.js"
import { syncMail } from "./sync.js"
import { type FakeMail, type FakeMailbox, fakeMailSource } from "./testing/index.js"

const ME = "owner@example.test"
const ALIAS = "me.alias@example.test"
const KEY = { provider: "email", account: ME }
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

const mail = (n: number, overrides: Partial<FakeMail> = {}): FakeMail => ({
  uid: String(100 + n),
  messageId: String(9000 + n),
  threadId: String(9000 + n),
  receivedAt: `2026-09-${String(10 + n).padStart(2, "0")}T08:00:00Z`,
  subject: `Synthetic subject ${n}`,
  from: ["Rin Example", "rin@example.test"],
  to: [[null, ME]],
  text: `Synthetic body ${n}`,
  ...overrides,
})

const opened: MessageStore[] = []

afterEach(async () => {
  for (const each of opened.splice(0)) await each.close()
})

const sandbox = async () => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "own-mail-")), "messages.db") }
  const store = await openStore({ env })
  opened.push(store)
  return store
}

const sync = (store: MessageStore, box: FakeMailbox, account: Partial<MailAccount> = {}) =>
  syncMail(fakeMailSource(box), store, { account: { address: ME, ...account }, since: SINCE, now: () => NOW })

const outgoing = async (store: MessageStore) => {
  const { id } = await store.accounts.storedAccount(KEY)
  const found = await store.mail.emails({ accountId: id })
  return Object.fromEntries(found.map((email) => [email.externalId, email.outgoing]))
}

const tiesOf = async (store: MessageStore, address: string) => {
  const person = await store.people.personOf({ provider: "email", id: address })
  if (!person) throw new Error(`no person for ${address}`)
  return (await store.people.ties([person.uid]))[person.uid]
}

const ownerHolds = async (store: MessageStore, address: string) =>
  (await store.people.owner())?.identities.some(({ provider, id }) => provider === "email" && id === address)

describe("the owner's mail", () => {
  it("takes Gmail mail under Sent from an alias as outgoing: its recipient gets a mail tie, the alias joins the owner", async () => {
    const store = await sandbox()
    const box: FakeMailbox = {
      messages: [
        mail(1),
        mail(2, {
          from: ["Owner Example", ALIAS],
          to: [["Pat Example", "pat@example.test"]],
          labels: ["Sent"],
        }),
      ],
    }

    await sync(store, box)

    expect(await outgoing(store)).toEqual({ "9001": false, "9002": true })
    expect(await tiesOf(store, "pat@example.test")).toContain("mail")
    expect(await tiesOf(store, "rin@example.test")).not.toContain("mail")
    expect(await ownerHolds(store, ME)).toBe(true)
    expect(await ownerHolds(store, ALIAS)).toBe(true)
  })

  it("reads an IMAP account's Sent folder by the source's word and stores mail in INBOX and Sent once", async () => {
    const store = await sandbox()
    const box: FakeMailbox = {
      sent: "Sent Items",
      messages: [
        mail(1),
        mail(2, { from: [null, ME], to: [["Pat Example", "pat@example.test"]], sent: true, absentFrom: ["INBOX"] }),
        mail(3, { from: [null, ME], to: [[null, ME]], sent: true }),
      ],
    }

    const result = await sync(store, box, { mode: "imap" })

    expect(result.coverage?.folders).toEqual(["INBOX", "Sent Items"])
    expect(result).toMatchObject({ listed: 3, saved: 3 })
    expect(await outgoing(store)).toEqual({ "9001": false, "9002": true, "9003": true })
    expect(await tiesOf(store, "pat@example.test")).toContain("mail")
    const { id } = await store.accounts.storedAccount(KEY)
    const self = (await store.mail.emails({ accountId: id })).find(({ externalId }) => externalId === "9003")
    expect(self?.mailboxes.map(({ externalId }) => externalId).sort()).toEqual(["INBOX", "Sent Items"])
    expect(await sync(store, box, { mode: "imap" })).toMatchObject({ saved: 0, alreadyStored: 3 })
  })

  it("takes IMAP mail in Sent from another address as the owner's", async () => {
    const store = await sandbox()
    const box: FakeMailbox = {
      sent: "Sent",
      messages: [
        mail(1),
        mail(2, {
          from: ["Owner Example", ALIAS],
          to: [["Pat Example", "pat@example.test"]],
          sent: true,
          absentFrom: ["INBOX"],
        }),
      ],
    }

    await sync(store, box, { mode: "imap" })

    expect(await outgoing(store)).toEqual({ "9001": false, "9002": true })
    expect(await tiesOf(store, "pat@example.test")).toContain("mail")
    expect(await ownerHolds(store, ALIAS)).toBe(true)
  })

  it("marks mail stored earlier from an address the owner then configures", async () => {
    const store = await sandbox()
    const box: FakeMailbox = {
      messages: [mail(1), mail(2, { from: ["Owner Example", ALIAS], to: [["Pat Example", "pat@example.test"]] })],
    }
    await sync(store, box)
    expect(await outgoing(store)).toEqual({ "9001": false, "9002": false })
    expect(await tiesOf(store, "pat@example.test")).not.toContain("mail")

    await sync(store, box, { addresses: [ALIAS.toUpperCase()] })

    expect(await outgoing(store)).toEqual({ "9001": false, "9002": true })
    expect(await tiesOf(store, "pat@example.test")).toContain("mail")
    expect(await ownerHolds(store, ALIAS)).toBe(true)
  })

  it("joins no alias to the owner while the account itself is not the owner's", async () => {
    const store = await sandbox()
    await store.people.savePeople({ provider: "telegram", account: "5" }, [{ id: "5", name: "Slava Owner" }])
    await store.people.linkToOwner({ provider: "telegram", id: "5" })
    const box: FakeMailbox = {
      messages: [
        mail(1, { to: [["Partner Example", ME]] }),
        mail(2, { from: ["Partner Example", ALIAS], to: [["Pat Example", "pat@example.test"]], labels: ["Sent"] }),
      ],
    }

    await sync(store, box)

    expect(await outgoing(store)).toEqual({ "9001": false, "9002": true })
    expect(await ownerHolds(store, ME)).toBe(false)
    expect(await ownerHolds(store, ALIAS)).toBe(false)
  })
})

describe("mailFolders", () => {
  const source = (sent?: string) => ({
    folders: async () => ({ all: "[Gmail]/All Mail", trash: "[Gmail]/Bin", ...(sent ? { sent } : {}) }),
  })

  it("reads INBOX and the Sent folder the source names on IMAP, and All Mail alone on Gmail", async () => {
    expect(await mailFolders({ mode: "imap" }, source("Sent"))).toEqual(["INBOX", "Sent"])
    expect(await mailFolders({ mode: "imap" }, source())).toEqual(["INBOX"])
    expect(await mailFolders({ mode: "imap" })).toEqual(["INBOX"])
    expect(await mailFolders({ mode: "imap", folders: ["Archive"] }, source("Sent"))).toEqual(["Archive"])
    expect(await mailFolders({}, source("Sent"))).toEqual(["[Gmail]/All Mail"])
  })
})
