import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { pull, type SourceParticipant } from "../meetings/index.js"
import { fakeMeetingSource } from "../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { personHistory } from "./communications.js"

const CRM = { provider: "bitrix24", account: "acme.example", scope: "work" as const }
const CALLS = { provider: "pbx-example", account: "office", scope: "work" as const }
const CHATS = { provider: "telegram", account: "500" }
const MAIL = { provider: "email", account: "owner@acme.example" }
const PHONE = "+34600555101"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const party = (role: string, identity: string, phone: string | null, name: string | null): SourceParticipant => ({
  identityExternalId: identity,
  phone,
  email: null,
  displayName: name,
  externalId: null,
  role,
  joinedAt: null,
  leftAt: null,
  durationMs: null,
  sessions: null,
  metadata: null,
})

const said = (id: string, timestamp: string, text: string) => ({
  id,
  chatId: "31",
  senderId: "21",
  senderName: "Marta Ficticia",
  timestamp,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** Marta Ficticia: a CRM contact with a mobile and an address, a Telegram dialog, a mail and an incoming call. */
const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "person-history-")), "store.db") })
  opened.push(store)
  await store.accounts.saveAccount(CRM, { name: null })
  await store.people.savePeople(CRM, [
    { id: "contact/7", name: "Marta Ficticia", phone: PHONE, email: "marta@northwind.example" },
  ])
  const calls = await store.accounts.saveAccount(CALLS, { name: null })
  const source = fakeMeetingSource({
    provider: CALLS.provider,
    meetings: async () => [
      {
        series: null,
        call: { direction: "in", clientPhone: PHONE },
        occurrence: {
          id: "call-1",
          seriesId: "call-1",
          title: `${PHONE} → 101`,
          startedAt: "2026-11-10T09:00:00.000Z",
          endedAt: "2026-11-10T09:04:00.000Z",
        },
      },
    ],
    participants: async () => [
      party("client", `phone:${PHONE}`, PHONE, null),
      party("manager", "extension:office/101", null, "Oleg Operatorov"),
    ],
    transcript: async () => [
      { startMs: 0, endMs: 9000, speaker: null, text: "We want the annual plan for 25 seats," },
      { startMs: 9000, endMs: 12000, speaker: null, text: "can you send a quote this week?" },
    ],
  })
  await pull(source, { ...store.meetings, linkCallers: undefined }, { accountId: calls, now: 4000 })
  await store.chats.saveChats(CHATS, [
    { id: "31", title: "Marta", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.messages.saveMessages(
    CHATS,
    "31",
    [said("1", "2026-11-11T09:15:00.000Z", "Hola, did you get the signed NDA?")],
    { via: "test" },
  )
  await store.roster.saveMembers(CHATS, "31", ["21"])
  await store.people.savePeople(CHATS, [{ id: "21", name: "Marta Ficticia" }])
  const mail = await store.accounts.saveAccount(MAIL, { name: null })
  await store.mail.saveThread({
    accountId: mail,
    externalId: "thread-1",
    now: Date.parse("2026-11-16T00:00:00Z"),
    emails: [
      {
        externalId: "<q1@northwind.example>",
        subject: "Quote for the annual plan",
        from: { address: "marta@northwind.example", name: "Marta Ficticia" },
        to: [{ address: "owner@acme.example", name: null }],
        sentAt: Date.parse("2026-11-12T08:00:00Z"),
        receivedAt: Date.parse("2026-11-12T08:00:00Z"),
        bodyText: "Please send the quote for 25 seats.",
      },
    ],
  })
  await store.people.scanMatches()
  const crm = await store.people.personOf({ provider: CRM.provider, id: "contact/7" })
  const chat = await store.people.personOf({ provider: CHATS.provider, id: "21" })
  await store.people.linkIdentities(
    { provider: CRM.provider, id: "contact/7" },
    { provider: CHATS.provider, id: "21" },
    { method: "manual", by: "owner" },
  )
  expect(chat?.uid).toBeDefined()
  return { store, person: `person:${crm?.uid}` }
}

describe("personHistory", () => {
  it("lists a person's message, mail and call newest first, the call with its direction and what was said", async () => {
    const { store, person } = await fixture()

    const history = await personHistory(store, person)

    expect(history.items.map(({ kind, at }) => [kind, at])).toEqual([
      ["mail", "2026-11-12T08:00:00.000Z"],
      ["message", "2026-11-11T09:15:00.000Z"],
      ["meeting", "2026-11-10T09:00:00.000Z"],
    ])
    expect(history.items[1]).toMatchObject({ text: "Hola, did you get the signed NDA?" })
    expect(history.items[2]).toMatchObject({
      ref: expect.stringMatching(/^meeting:/),
      text: "We want the annual plan for 25 seats, can you send a quote this week?",
      durationMs: 240_000,
      call: { direction: "in", client_phone: PHONE, manager: { name: "Oleg Operatorov" } },
    })
    expect(history).toMatchObject({ hasMore: false, next: null })
  })

  it("pages back from the newest: next is the until of the older page, and each item comes once", async () => {
    const { store, person } = await fixture()

    const first = await personHistory(store, person, { limit: 2 })
    expect(first.items.map(({ kind }) => kind)).toEqual(["mail", "message"])
    expect(first).toMatchObject({ hasMore: true, next: "2026-11-11T09:14:59.999Z" })

    const second = await personHistory(store, person, { limit: 2, until: Date.parse(first.next as string) })
    expect(second.items.map(({ kind }) => kind)).toEqual(["meeting"])
    expect(second).toMatchObject({ hasMore: false, next: null })
  })

  it("says there is more when one dialog alone holds the next page", async () => {
    const { store, person } = await fixture()
    await store.messages.saveMessages(
      CHATS,
      "31",
      [said("2", "2026-11-13T09:00:00.000Z", "Any news?"), said("3", "2026-11-14T09:00:00.000Z", "Friday then.")],
      { via: "test" },
    )

    const first = await personHistory(store, person, { limit: 1, since: Date.parse("2026-11-13T00:00:00Z") })

    expect(first.items.map(({ text }) => text)).toEqual(["Friday then."])
    expect(first).toMatchObject({ hasMore: true, next: "2026-11-14T08:59:59.999Z" })
  })

  it("reads only the accounts asked for", async () => {
    const { store, person } = await fixture()

    const history = await personHistory(store, person, { accounts: [MAIL] })

    expect(history.items.map(({ kind }) => kind)).toEqual(["mail"])
  })

  it("refuses a range that ends before it starts, and a reference that is not a person", async () => {
    const { store, person } = await fixture()

    await expect(personHistory(store, person, { since: 2, until: 1 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(personHistory(store, "telegram:21")).rejects.toMatchObject({ code: "validation_error" })
  })
})
