import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/index.js"
import { MEETING_NOTES, notesOf, saveMeetingNotes } from "./meeting-notes.js"
import { ruleInput } from "./rule-input.js"
import { storedMailRule } from "./rule-stored.js"
import type { MailRule } from "./rules.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const ME = "owner@example.test"
const ROOM = "https://telemost.360.yandex.ru/j/1234567890"
const NOTES = [
  "Конспект встречи",
  "",
  "Итоги",
  "Договорились выпустить синтетическую версию.",
  "",
  "Что обсудили",
  "ТЕМА 1. Пример темы",
  "Участники обсуждения: Синтетик Один",
  "",
  "Задачи:",
  "ЗАДАЧА 1. Написать пример",
  "Ответственные: Синтетик Два",
  "",
  "Открытые вопросы",
  "ВОПРОС 1. Когда?",
  "",
  `Ссылка на встречу: ${ROOM}?code=SECRET`,
].join("\n")

const RULE: MailRule = {
  match: { from: "keeper@telemost.yandex.ru" },
  action: "keep",
  protected: true,
  meeting_notes: "telemost",
  decided_at: "2026-11-13T00:00:00Z",
}

const seeded = async () => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "meeting-notes-")), "wirecat.db") }
  const store = await openStore({ env })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "email", account: ME }, { name: ME })
  const sent = new Date(2026, 10, 12, 18, 0).getTime()
  await store.mail.saveThread({
    accountId,
    externalId: "t1",
    now: 1,
    emails: [
      {
        externalId: "<notes-1@example.test>",
        subject: "Конспект встречи от 12.11.2026",
        from: { address: "keeper@telemost.yandex.ru", name: "Хранитель встреч Телемоста" },
        to: [{ address: ME, name: null }],
        cc: [],
        sentAt: sent,
        receivedAt: sent,
        references: [],
        bodyText: NOTES,
        outgoing: false,
        read: true,
        mailboxes: [],
      },
      {
        externalId: "<other@example.test>",
        subject: "Not notes",
        from: { address: "friend@example.test", name: "Friend" },
        to: [{ address: ME, name: null }],
        cc: [],
        sentAt: sent,
        receivedAt: sent,
        references: [],
        bodyText: `Join me at ${ROOM}`,
        outgoing: false,
        read: true,
        mailboxes: [],
      },
    ],
  })
  return store
}

it("cuts Telemost's notes at their headings, the summary first", () => {
  const notes = notesOf(NOTES, MEETING_NOTES.telemost as (typeof MEETING_NOTES)[string])
  expect(notes.overview).toBe("Договорились выпустить синтетическую версию.")
  expect(notes.sections.map(({ label }) => label)).toEqual(["Что обсудили", "Задачи", "Открытые вопросы"])
  expect(notes.content).toContain("ЗАДАЧА 1")
})

it("reads older notes with no summary heading, and leaves Yandex's footer out", () => {
  const older = [
    "Конспект встречи",
    "",
    "Обсудили синтетический релиз и договорились о сроках.",
    "",
    "Задачи",
    "ЗАДАЧА 1. Написать пример",
    "",
    "Оцените точность конспекта",
    "Используйте все сервисы Яндекс 360",
  ].join("\n")
  const notes = notesOf(older, MEETING_NOTES.telemost as (typeof MEETING_NOTES)[string])
  expect(notes.overview).toBe("Обсудили синтетический релиз и договорились о сроках.")
  expect(notes.sections).toEqual([{ label: "Задачи", text: "ЗАДАЧА 1. Написать пример" }])
  expect(notes.content).not.toContain("Яндекс 360")
})

it("saves one meeting per notes email the rule matches, again and again as the same one, and makes no event", async () => {
  const store = await seeded()
  const since = "2026-01-01T00:00:00Z"
  const first = await saveMeetingNotes(store, ME, [RULE], { since, now: 10 })
  expect(first.telemost).toMatchObject({ meetings: 1, summaries: 1, warnings: [] })
  await saveMeetingNotes(store, ME, [RULE], { since, now: 20 })

  const account = await store.accounts.storedAccount({ provider: "telemost", account: ME })
  const meetings = await store.meetings.meetings({ accountId: account.id, limit: 10 })
  expect(meetings).toHaveLength(1)
  const details = await store.meetings.meeting(meetings[0]?.id as number)
  expect(details?.meeting).toMatchObject({
    externalId: "<notes-1@example.test>",
    joinUrl: ROOM,
    startedAt: new Date(2026, 10, 12).getTime(),
    eventId: null,
    metadata: { time_precision: "day" },
  })
  expect(details?.summaries[0]?.overview).toBe("Договорились выпустить синтетическую версию.")
  expect(JSON.stringify(details)).not.toContain("SECRET")
  expect(await store.meetings.events()).toEqual([])
})

it("takes the hours and the event from the owner's calendar entry in the same room that day", async () => {
  const store = await seeded()
  const calendarAccount = await store.accounts.saveAccount({ provider: "google-calendar", account: ME }, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    calendarAccount,
    [{ externalId: "c", title: "Work", timezone: null, accessRole: "owner", primary: true, syncByDefault: true }],
    0,
  )
  const startsAt = new Date(2026, 10, 12, 11, 0).getTime()
  const [entry] = await store.calendar.saveEntries(
    calendar?.id as number,
    [
      {
        externalId: "e1",
        kind: "single",
        status: "confirmed",
        title: "Weekly sync",
        startsAt,
        endsAt: startsAt + 3_600_000,
        joinUrl: ROOM,
      },
    ],
    0,
  )

  await saveMeetingNotes(store, ME, [RULE], { since: "2026-01-01T00:00:00Z", now: 10 })

  const account = await store.accounts.storedAccount({ provider: "telemost", account: ME })
  const [meeting] = await store.meetings.meetings({ accountId: account.id, limit: 10 })
  expect(meeting).toMatchObject({
    title: "Weekly sync",
    startedAt: startsAt,
    endedAt: startsAt + 3_600_000,
    eventId: entry?.eventId,
    metadata: { time_precision: "event" },
  })
})

it("finds a meeting just after midnight in Moscow, which is still the evening before here", async () => {
  const store = await seeded()
  const calendarAccount = await store.accounts.saveAccount({ provider: "google-calendar", account: ME }, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    calendarAccount,
    [{ externalId: "c", title: "Work", timezone: null, accessRole: "owner", primary: true, syncByDefault: true }],
    0,
  )
  const startsAt = Date.UTC(2026, 10, 12) - 3 * 3_600_000 + 30 * 60_000
  await store.calendar.saveEntries(
    calendar?.id as number,
    [
      {
        externalId: "e1",
        kind: "single",
        status: "confirmed",
        title: "Late call",
        startsAt,
        endsAt: startsAt + 1_800_000,
        joinUrl: ROOM,
      },
    ],
    0,
  )
  await saveMeetingNotes(store, ME, [RULE], { since: "2026-01-01T00:00:00Z", now: 10 })
  const account = await store.accounts.storedAccount({ provider: "telemost", account: ME })
  const [meeting] = await store.meetings.meetings({ accountId: account.id, limit: 10 })
  expect(meeting).toMatchObject({ title: "Late call", startedAt: startsAt })
})

it("keeps a linked meeting's hours when its event is no longer the only one that day", async () => {
  const store = await seeded()
  const calendarAccount = await store.accounts.saveAccount({ provider: "google-calendar", account: ME }, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    calendarAccount,
    [{ externalId: "c", title: "Work", timezone: null, accessRole: "owner", primary: true, syncByDefault: true }],
    0,
  )
  const entry = (externalId: string, hour: number) => {
    const startsAt = new Date(2026, 10, 12, hour).getTime()
    return {
      externalId,
      kind: "single" as const,
      status: "confirmed" as const,
      title: externalId,
      startsAt,
      endsAt: startsAt + 3_600_000,
      joinUrl: ROOM,
    }
  }
  await store.calendar.saveEntries(calendar?.id as number, [entry("first", 11)], 0)
  await saveMeetingNotes(store, ME, [RULE], { since: "2026-01-01T00:00:00Z", now: 10 })
  await store.calendar.saveEntries(calendar?.id as number, [entry("second", 15)], 1)
  await saveMeetingNotes(store, ME, [RULE], { since: "2026-01-01T00:00:00Z", now: 20 })

  const account = await store.accounts.storedAccount({ provider: "telemost", account: ME })
  const [meeting] = await store.meetings.meetings({ accountId: account.id, limit: 10 })
  expect(meeting).toMatchObject({ title: "first", startedAt: new Date(2026, 10, 12, 11).getTime() })
})

it("keeps the meeting-notes provider when a rule is stored and read back", () => {
  const input = ruleInput(RULE)
  expect(input.actions).toMatchObject({ store: "full", meeting_notes: "telemost" })
  const stored = storedMailRule({ id: 1, ...input, accountId: 1, createdAt: 0, updatedAt: 0 } as never)
  expect(stored?.meeting_notes).toBe("telemost")
})
