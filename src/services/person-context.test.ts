import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Chat, Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { type ServiceDeps, storedDeps } from "./deps.js"
import { peopleService } from "./people.js"
import { identityIn, personContext } from "./person-context.js"

const tg = { provider: "telegram", account: "500" }
const max = { provider: "max", account: "900" }
const messenger = { provider: "telegram", chatArgument: "a chat", app: { command: "tg" } } as Messenger

const chat = (id: string, kind: Chat["kind"], title: string, last = "2026-09-03T12:00:00.000Z"): Chat => ({
  id,
  title,
  kind,
  unreadCount: 0,
  lastMessageAt: last,
  participantsCount: null,
})

const message = (
  chatId: string,
  id: string,
  senderId: string,
  text: string,
  extra: Partial<Message> = {},
): Message => ({
  id,
  chatId,
  senderId,
  senderName: null,
  timestamp: `2026-09-02T10:0${id}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

let store: MessageStore
const people = () => peopleService(storedDeps(messenger, store, tg, {} as SendGuard))

beforeEach(async () => {
  store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "person-")), "m.db") })
  await store.chats.saveChats(tg, [
    chat("11", "dialog", "Ana", "2026-09-02T10:02:00.000Z"),
    chat("12", "dialog", "Ana", "2026-09-02T10:01:00.000Z"),
    chat("-7", "group", "Club"),
  ])
  await store.people.savePeople(tg, [
    { id: "11", name: "Ana", username: "ana_a" },
    { id: "12", name: "Ana", username: "ana_ab" },
    { id: "13", name: "Bo" },
  ])
  await store.messages.saveMessages(
    tg,
    "11",
    [message("11", "1", "11", "from the first Ana"), message("11", "2", "500", "to the first Ana", { outgoing: true })],
    { via: "test" },
  )
  await store.messages.saveMessages(tg, "12", [message("12", "1", "12", "from the second Ana")], { via: "test" })
  await store.messages.saveMessages(
    tg,
    "-7",
    [
      message("-7", "1", "11", "first in the group"),
      message("-7", "2", "12", "second in the group"),
      message("-7", "3", "13", "ask @ana_a"),
      message("-7", "4", "13", "ask @ana_ab"),
    ],
    { via: "test" },
  )
  await store.roster.saveMembers(tg, "11", ["11", "500"])
  await store.roster.saveMembers(tg, "12", ["12", "500"])
  await store.roster.saveMembers(tg, "-7", ["11", "12", "13", "500"])
  for (const [id, last] of [
    ["11", 2],
    ["12", 1],
  ] as const) {
    await store.sync.markRange(tg, id, 1, last)
    await store.sync.setSyncState(tg, historyStartKey(id), "1")
  }

  await store.chats.saveChats(max, [chat("m1", "dialog", "Ana")])
  await store.people.savePeople(max, [{ id: "m5", name: "Ana" }])
  await store.messages.saveMessages(max, "m1", [message("m1", "5", "m5", "from Ana on MAX")], { via: "test" })
  await store.roster.saveMembers(max, "m1", ["m5", "900"])
})

afterEach(async () => {
  await store.close()
})

const texts = (items: { text: string }[]) => items.map((one) => one.text)

describe("contacts context", () => {
  it("finds direct messages and the last each way when the dialog has no recorded members", async () => {
    await store.roster.saveMembers(tg, "11", [])

    const found = await people().context("11")
    expect(texts(found.recent.direct)).toEqual(["to the first Ana", "from the first Ana"])
    expect(found.last.fromThem?.text).toBe("from the first Ana")
    expect(found.last.fromMe?.text).toBe("to the first Ana")
    expect(found.shared).toContainEqual(expect.objectContaining({ provider: "telegram", chatId: "11" }))
  })

  it("finds the last message each way in the whole dialog, however few messages it returns", async () => {
    const newestOnly = await personContext(store, tg, "11", { messages: 1 })
    expect(texts(newestOnly.recent.direct)).toEqual(["to the first Ana"])
    expect(newestOnly.last.fromThem?.text).toBe("from the first Ana")

    await store.messages.saveMessages(tg, "11", [message("11", "3", "11", "from the first Ana again")], { via: "test" })
    expect((await personContext(store, tg, "11", { messages: 1 })).last.fromMe?.text).toBe("to the first Ana")
  })

  it("keeps two people with one name apart and refuses to guess between them", async () => {
    await expect(people().context("Ana")).rejects.toMatchObject({
      message: expect.stringContaining("matches 2 people"),
    })

    const found = await people().context("11")
    expect(found.person.identities.map((one) => one.id)).toEqual(["11"])
    expect(texts(found.recent.direct)).toEqual(["to the first Ana", "from the first Ana"])
    expect(texts(found.recent.groups)).toEqual(["first in the group"])
    expect(texts(found.mentions)).toEqual(["ask @ana_a"])
    expect(found.last.fromThem?.text).toBe("from the first Ana")
    expect(found.last.fromMe?.text).toBe("to the first Ana")
    expect(found.recent.direct[0]?.locator).toBe("msg:telegram/500/11/2")
  })

  it("is incomplete while a shared chat is not stored whole", async () => {
    const found = await people().context("11")
    expect(found.complete).toBe(false)
    expect(found.notRead).toEqual([
      expect.objectContaining({ provider: "telegram", account: "500", chatId: "-7", reason: expect.any(String) }),
    ])
  })

  it("spans a linked MAX identity until it is unlinked", async () => {
    const linked = await people().link("11", "max:m5")
    expect(linked.identities.map((one) => `${one.provider}:${one.id}`)).toEqual(["max:m5", "telegram:11"])

    const both = await people().context("11")
    expect(texts(both.recent.direct)).toContain("from Ana on MAX")
    expect(both.shared).toContainEqual(expect.objectContaining({ provider: "max", account: "900", chatId: "m1" }))

    await people().unlink("max:m5")
    const alone = await people().context("11")
    expect(alone.person.identities).toHaveLength(1)
    expect(texts(alone.recent.direct)).not.toContain("from Ana on MAX")
  })

  it("links a calendar attendee's email contact to a Telegram person", async () => {
    const calendarAccount = await store.accounts.saveAccount(
      { provider: "google-calendar", account: "owner-1" },
      { name: null },
    )
    const [calendar] = await store.calendar.saveCalendars(
      calendarAccount,
      [
        {
          externalId: "primary",
          title: "Work",
          timezone: "UTC",
          accessRole: "owner",
          primary: true,
          syncByDefault: true,
        },
      ],
      1,
    )
    await store.calendar.saveEntries(
      calendar?.id as number,
      [
        {
          externalId: "g1",
          kind: "single",
          status: "confirmed",
          title: "Planning",
          startsAt: 1,
          endsAt: 2,
          participants: [{ email: "Ana@X.com", name: "Ana from the calendar" }],
        },
      ],
      1,
    )

    const linked = await people().link("11", "email:ana@x.com")

    expect(linked.identities.map((one) => `${one.provider}:${one.id}`)).toEqual(["email:ana@x.com", "telegram:11"])
  })

  it("lists the calendar events of their linked email contact, one occurrence per series", async () => {
    const now = Date.UTC(2026, 9, 26, 12)
    const day = 86_400_000
    const calendarAccount = await store.accounts.saveAccount(
      { provider: "google-calendar", account: "owner-1" },
      { name: null },
    )
    const [calendar] = await store.calendar.saveCalendars(
      calendarAccount,
      [
        {
          externalId: "primary",
          title: "Work",
          timezone: "UTC",
          accessRole: "owner",
          primary: true,
          syncByDefault: true,
        },
      ],
      1,
    )
    const ana = [{ email: "ana@x.com", name: "Ana" }]
    const at = (externalId: string, title: string, startsAt: number, extra: object = {}) => ({
      externalId,
      kind: "single" as const,
      status: "confirmed" as const,
      title,
      startsAt,
      endsAt: startsAt + 3_600_000,
      participants: ana,
      ...extra,
    })
    await store.calendar.saveEntries(
      calendar?.id as number,
      [
        at("past", "Kick-off", now - 3 * day),
        at("gone", "Called off", now + day, { status: "cancelled" }),
        at("other", "Without her", now + day, { participants: [{ email: "bo@x.com" }] }),
        at("s1", "Weekly sync", now + 2 * day, { kind: "series", recurrence: ["RRULE:FREQ=WEEKLY"] }),
        ...[0, 1, 2].map((week) =>
          at(`s1_${week}`, "Weekly sync", now + (2 + 7 * week) * day, {
            kind: "occurrence",
            seriesExternalId: "s1",
            originalStartsAt: now + (2 + 7 * week) * day,
          }),
        ),
      ],
      1,
    )
    await people().link("11", "email:ana@x.com")

    const found = await people().context("11", { now })

    expect(found.events.upcoming.map(({ title, startsAt }) => [title, startsAt])).toEqual([
      ["Weekly sync", new Date(now + 2 * day).toISOString()],
    ])
    expect(found.events.recent.map(({ title }) => title)).toEqual(["Kick-off"])
    expect(found.events.upcoming[0]?.ref).toMatch(/^event:\d+$/)

    await store.calendar.markUnseen(calendar?.id as number, now, { from: now - 30 * day, to: now + 30 * day }, now)
    const after = await people().context("11", { now })
    expect(after.events.upcoming).toEqual([])
    expect(after.events.recent.map(({ title }) => title)).toEqual(["Kick-off"])
  })

  it("keeps a renamed person's history and key", async () => {
    const before = await people().context("11")
    await store.people.savePeople(tg, [{ id: "11", name: "Ana María" }])
    const after = await people().context("11")
    expect(after.person.uid).toBe(before.person.uid)
    expect(texts(after.recent.direct)).toEqual(texts(before.recent.direct))
  })
})

describe("contacts context in named chats", () => {
  beforeEach(async () => {
    await store.messages.saveMessages(
      tg,
      "-7",
      [
        message("-7", "5", "11", "fifth"),
        message("-7", "6", "11", "sixth", { replyTo: null }),
        message("-7", "7", "11", "seventh"),
      ],
      { via: "test" },
    )
  })

  it("gives their newest in each chat, oldest first, as when and what only", async () => {
    const found = await people().messagesIn("11", { chats: ["-7", "11"], limit: 2 })

    expect(found.person).toMatchObject({ provider: "telegram", id: "11" })
    expect(found.chats.map((one) => [one.chat.id, one.messages, one.more])).toEqual([
      [
        "-7",
        [
          { at: "2026-09-02T10:06:00.000Z", text: "sixth" },
          { at: "2026-09-02T10:07:00.000Z", text: "seventh" },
        ],
        true,
      ],
      ["11", [{ at: "2026-09-02T10:01:00.000Z", text: "from the first Ana" }], false],
    ])
  })

  it("adds ids and locators only when asked", async () => {
    const found = await people().messagesIn("11", { chats: ["11"], detail: 1 })

    expect(found.chats[0]?.messages[0]).toMatchObject({ id: "1", locator: "msg:telegram/500/11/1", senderId: "11" })
  })

  it("answers a chat they never wrote in empty, saying whether it is held whole", async () => {
    const found = await people().messagesIn("11", { chats: ["12"] })

    expect(found.chats).toEqual([
      { chat: { id: "12", title: "Ana", kind: "dialog" }, messages: [], complete: true, more: false },
    ])
  })

  it("calls a chat named by the person's own id their dialog when the store has no such chat", async () => {
    await store.messages.saveMessages(tg, "13", [message("13", "40", "13", "hello")], { via: "test" })
    const found = await people().messagesIn("13", { chats: ["13"] })

    expect(found.chats[0]?.chat.kind).toBe("dialog")
  })

  it("reads each chat from the messenger first with refresh, by sender, once per chat", async () => {
    const asked: string[] = []
    const fresh = message("-7", "9", "11", "fresh from the messenger", { timestamp: "2026-09-04T10:00:00.000Z" })
    const service = peopleService({
      ...storedDeps(messenger, store, tg, {} as SendGuard),
      offline: false,
      connection: async () =>
        ({
          resolve: async (chat: string) => ({ ...chat_("-7"), id: chat }),
          historyFrom: async (chat: string, person: string) => {
            asked.push(`${chat}:${person}`)
            return { items: chat === "-7" ? [fresh] : [], hasMore: false }
          },
        }) as unknown as Awaited<ReturnType<ServiceDeps["connection"]>>,
    })

    const found = await service.messagesIn("11", { chats: ["-7", "11"], limit: 1, fetch: true })

    expect(asked).toEqual(["-7:11", "11:11"])
    expect(found.chats[0]?.messages).toEqual([{ at: "2026-09-04T10:00:00.000Z", text: "fresh from the messenger" }])
  })
})

const chat_ = (id: string) => chat(id, "group", "Club")

describe("identityIn", () => {
  it("reads a person: reference as that person's identity in the asked messenger, and says when there is none", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "person-ref-")), "store.db") })
    try {
      const telegram = { provider: "telegram", account: "1" }
      await store.people.savePeople(telegram, [{ id: "101", name: "Ana Example" }])
      const mail = { provider: "email", account: "owner@example.test" }
      const accountId = await store.accounts.saveAccount(mail, { name: null })
      await store.mail.saveThread({
        accountId,
        externalId: "thread-1",
        now: Date.UTC(2026, 0, 2),
        emails: [
          {
            externalId: "<one@example.test>",
            subject: "Hello",
            from: { address: "ana@example.test", name: "Ana Example" },
            sentAt: Date.UTC(2026, 0, 1),
            bodyText: "Synthetic body",
          },
        ],
      })
      const person = await store.people.linkIdentities(
        { provider: "email", id: "ana@example.test" },
        { provider: "telegram", id: "101" },
        { method: "manual", by: "owner" },
      )

      expect(await identityIn(store, telegram, `person:${person.uid}`)).toEqual({ provider: "telegram", id: "101" })
      expect(await identityIn(store, mail, `person:${person.uid}`)).toEqual({
        provider: "email",
        id: "ana@example.test",
      })
      await expect(identityIn(store, { provider: "max", account: "7" }, `person:${person.uid}`)).rejects.toMatchObject({
        code: "not_found",
        message: expect.stringContaining("has no max identity"),
      })
      await expect(identityIn(store, telegram, "person:999999")).rejects.toMatchObject({ code: "not_found" })
    } finally {
      await store.close()
    }
  })
})
