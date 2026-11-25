import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { syncMail } from "../mail/sync.js"
import { type FakeMail, type FakeMailbox, fakeMailSource } from "../mail/testing/index.js"
import { type MessageStore, openStore } from "./store.js"

const ME = "owner@home.example.com"
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

let n = 0
const mail = (from: [string, string], subject: string, overrides: Partial<FakeMail> = {}): FakeMail => {
  n += 1
  return {
    uid: String(100 + n),
    messageId: `<m${n}@test.example.com>`,
    threadId: String(9000 + n),
    receivedAt: `2026-09-${String(10 + (n % 15)).padStart(2, "0")}T08:00:00Z`,
    subject,
    from,
    to: [[null, ME]],
    text: `Synthetic body ${n}`,
    ...overrides,
  }
}

const AUTHOR: [string, string] = ["Ada Quill", "ada@quill.substack.example.com"]

const issue = (subject: string) =>
  mail(AUTHOR, subject, {
    extraHeaders: [
      "List-Unsubscribe: <https://quill.substack.example.com/unsubscribe>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      "DKIM-Signature: v=1; a=rsa-sha256; d=quill.substack.example.com; s=s1; h=from:to:subject:list-unsubscribe-post; b=abc",
      "Authentication-Results: mx.example.com; dkim=pass header.i=@quill.substack.example.com header.s=s1 header.b=abc",
    ],
    listId: "<quill.substack.example.com>",
  })

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const opened = async (messages: FakeMail[]) => {
  const path = join(mkdtempSync(join(tmpdir(), "newsletter-bots-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  const mailbox: FakeMailbox = { messages }
  const sync = () =>
    syncMail(fakeMailSource(mailbox), store, { account: { address: ME }, since: SINCE, now: () => NOW })
  await sync()
  return { store, mailbox, sync }
}

const sorted = async (store: MessageStore) => {
  await store.people.list({ limit: 0 })
  return (await store.people.listBots({ limit: 50 })).items
}

const botNames = async (store: MessageStore) =>
  (await sorted(store)).map(({ displayName, reason }) => ({ displayName, reason }))

const listed = async (store: MessageStore) =>
  (await store.people.list({ limit: 50, kind: "all" })).items.map(({ displayName }) => displayName)

const reaches = async (store: MessageStore) =>
  Object.fromEntries(
    (await store.mail.emails({ limit: 50 })).flatMap((email) =>
      email.outgoing ? [] : [[email.subject, { type: email.mailType, reach: email.reach }]],
    ),
  )

it("makes a sender of a newsletter only a bot, a human author too, and keeps its mail typed a newsletter", async () => {
  const { store } = await opened([issue("Notes from the road"), issue("Notes from the sea")])

  expect(await botNames(store)).toEqual([{ displayName: "Ada Quill", reason: "newsletter-only" }])
  expect(await listed(store)).not.toContain("Ada Quill")
  expect(await reaches(store)).toEqual({
    "Notes from the road": { type: "newsletter", reach: "broadcast" },
    "Notes from the sea": { type: "newsletter", reach: "broadcast" },
  })
})

it("gives the bot back once the owner replies, and only its newsletter mail keeps reach broadcast", async () => {
  const { store, mailbox, sync } = await opened([issue("Notes from the road")])
  expect(await botNames(store)).toHaveLength(1)

  mailbox.messages.push(
    mail(["Me", ME], "Re: Notes from the road", { to: [[null, AUTHOR[1]]], sent: true }),
    mail(AUTHOR, "Re: Re: Notes from the road"),
  )
  await sync()

  expect(await botNames(store)).toEqual([])
  const ada = (await store.people.list({ limit: 50, kind: "all" })).items.find(
    ({ displayName }) => displayName === "Ada Quill",
  )
  expect(ada).toMatchObject({ displayName: "Ada Quill", reach: "direct", ties: ["mail"] })
  expect(await reaches(store)).toEqual({
    "Notes from the road": { type: "newsletter", reach: "broadcast" },
    "Re: Re: Notes from the road": { type: "personal", reach: "direct" },
  })
})

it("gives the bot back after a 1-to-1 mail from its address, though the owner never wrote", async () => {
  const { store, mailbox, sync } = await opened([issue("Notes from the road")])
  expect(await botNames(store)).toHaveLength(1)

  mailbox.messages.push(mail(AUTHOR, "A question for you"))
  await sync()

  expect(await botNames(store)).toEqual([])
  expect(await listed(store)).toContain("Ada Quill")
})

it("keeps a person the owner writes to who also sends a newsletter, and a discussion list's members", async () => {
  const list = "<dev.lists.example.org>"
  const { store } = await opened([
    mail(["Me", ME], "Lunch?", { to: [[null, AUTHOR[1]]], sent: true }),
    issue("Notes from the road"),
    mail(["Bo Lind", "bo@dev.example.org"], "[dev] release plan", { listId: list }),
    mail(["Cy Moor", "cy@dev.example.org"], "[dev] re: release plan", { listId: list }),
    mail(["Di Park", "di@dev.example.org"], "[dev] re: re: release plan", { listId: list }),
  ])

  expect(await botNames(store)).toEqual([])
  expect(await listed(store)).toEqual(expect.arrayContaining(["Ada Quill", "Bo Lind", "Cy Moor", "Di Park"]))
})

it("keeps the owner's choice over the newsletter rule", async () => {
  const { store } = await opened([issue("Notes from the road")])
  const [bot] = await sorted(store)

  await store.people.moveToPerson(String(bot?.bot), "owner")
  await store.people.list({ limit: 0, kind: "all" })

  expect(await botNames(store)).toEqual([])
  expect(await listed(store)).toContain("Ada Quill")
})
