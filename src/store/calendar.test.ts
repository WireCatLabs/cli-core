import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { linkEvent } from "../meetings/index.js"
import { CONTRACT_NOW, eventStoreContract, sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "./open.js"
import { eventStoreOver } from "./sqlite/calendar.js"
import type { StoreContext } from "./sqlite/open.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const HOUR = 3_600_000
const PASSCODE = "Zq81Synthetic"

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "calendar-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "google-calendar", account: "owner-1" },
    { name: null },
  )
  const zoom = await store.accounts.saveAccount({ provider: "zoom", account: "zoom-1" }, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    accountId,
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
  return { store, path, accountId, zoom, calendar: calendar?.id as number }
}

/** A Zoom meeting saved and linked the way zm does it: an automatic event of its own. */
const zoomMeeting = async (store: MessageStore, accountId: number, externalId: string, startedAt: number) => {
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.meeting.externalId = externalId
  input.meeting.joinUrl = `https://example.zoom.us/j/81234567890?pwd=${PASSCODE}`
  input.meeting.startedAt = startedAt
  input.meeting.endedAt = startedAt + HOUR
  delete input.meeting.series
  const saved = await store.meetings.saveMeeting(input)
  return { saved, event: await linkEvent(store.meetings, saved, 1) }
}

describe("SQLite event store", () => {
  for (const { name, run } of eventStoreContract(async () => {
    const { store, accountId } = await setup()
    const otherAccountId = await store.accounts.saveAccount(
      { provider: "google-calendar", account: "owner-2" },
      { name: null },
    )
    return { store: store.calendar, accountId, otherAccountId }
  }))
    it(`contract: ${name}`, run)

  it("a list of events by time seeks the time index, dated or not", async () => {
    const { store, path, calendar } = await setup()
    const at = CONTRACT_NOW
    await store.calendar.saveEntries(
      calendar,
      [{ externalId: "e1", kind: "single", status: "confirmed", title: "Review", startsAt: at, endsAt: at + HOUR }],
      at,
    )
    const database = await openCache(path)
    const asked: string[] = []
    const spy = new Proxy(database, {
      get: (target, key) =>
        key === "prepare"
          ? (sql: string) => {
              asked.push(sql)
              return target.prepare(sql)
            }
          : Reflect.get(target, key),
    })
    const events = eventStoreOver({ database: spy, now: () => at } as unknown as StoreContext)
    for (const filter of [
      { from: at - HOUR, to: at + HOUR },
      { from: at - HOUR, to: at + HOUR, fromDate: "1970-02-11", toDate: "1970-02-13" },
    ]) {
      asked.length = 0
      expect(await events.events(filter)).toHaveLength(1)
      const sql = asked.find((one) => one.startsWith("SELECT e.* FROM events e")) as string
      const params = Array.from({ length: (sql.match(/\?/gu) ?? []).length }, () => 0)
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail))
      expect(plan.join(" | ")).toMatch(/SEARCH e USING INDEX events_by_time \(starts_at>\? AND starts_at<\?\)/u)
    }
    database.close()
  })

  it("rule 4: an entry for a Zoom meeting's room at its time adopts the meeting's automatic event", async () => {
    const { store, zoom, calendar } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    const { event } = await zoomMeeting(store, zoom, "occ-1", at)
    expect(event?.origin).toBe("auto")
    const [entry] = await store.calendar.saveEntries(
      calendar,
      [
        {
          externalId: "g1",
          kind: "single",
          status: "confirmed",
          title: "Planning",
          startsAt: at,
          endsAt: at + HOUR,
          joinUrl: "https://example.zoom.us/j/81234567890?pwd=other",
        },
      ],
      2,
    )
    expect(entry?.eventId).toBe(event?.id)
    expect((await store.calendar.event(event?.id as number))?.event.origin).toBe("calendar")
  })

  it("rule 4: two Zoom events in one room at that time make no link and one review entry", async () => {
    const { store, zoom, calendar, path } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    const first = await zoomMeeting(store, zoom, "occ-1", at)
    const database = await openCache(path)
    database.prepare("UPDATE meetings SET event_id = NULL").run()
    await zoomMeeting(store, zoom, "occ-2", at)
    database.prepare("UPDATE meetings SET event_id = ? WHERE external_id = 'occ-1'").run(first.event?.id as number)
    database.close()
    const entry = {
      externalId: "g1",
      kind: "single" as const,
      status: "confirmed" as const,
      startsAt: at,
      endsAt: at + HOUR,
      joinUrl: "https://example.zoom.us/j/81234567890",
    }
    const [saved] = await store.calendar.saveEntries(calendar, [entry], 2)
    await store.calendar.saveEntries(calendar, [entry], 3)
    expect(saved?.eventId).toBeNull()
    expect((await store.calendar.reviews()).map(({ reason, candidates }) => [reason, candidates.length])).toEqual([
      ["join-key", 2],
    ])
  })

  it("links a Zoom meeting to the calendar's event by its room, though the event has no meeting yet", async () => {
    const { store, zoom, calendar } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    const [entry] = await store.calendar.saveEntries(
      calendar,
      [
        {
          externalId: "g1",
          kind: "single",
          status: "confirmed",
          startsAt: at,
          endsAt: at + HOUR,
          joinUrl: `https://example.zoom.us/j/81234567890?pwd=${PASSCODE}`,
        },
      ],
      2,
    )
    const { event } = await zoomMeeting(store, zoom, "occ-1", at + 5 * 60_000)
    expect(event?.id).toBe(entry?.eventId)
  })

  it("does not link a meeting to the event that ends as it starts: ends are exclusive", async () => {
    const { store, zoom, calendar } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    const room = "https://example.zoom.us/j/81234567890"
    const [before, own] = await store.calendar.saveEntries(
      calendar,
      [
        { externalId: "a", kind: "single", status: "confirmed", startsAt: at - HOUR, endsAt: at, joinUrl: room },
        { externalId: "b", kind: "single", status: "confirmed", startsAt: at, endsAt: at + HOUR, joinUrl: room },
      ],
      2,
    )
    const { event } = await zoomMeeting(store, zoom, "occ-1", at)
    expect(event?.id).toBe(own?.eventId)
    expect(event?.id).not.toBe(before?.eventId)
  })

  it("keeps a title that names a PIN or a password, which is the meeting's name", async () => {
    const { store, calendar } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    const [entry] = await store.calendar.saveEntries(
      calendar,
      [
        {
          externalId: "t",
          kind: "single",
          status: "confirmed",
          title: "PIN reset review",
          startsAt: at,
          endsAt: at + HOUR,
        },
      ],
      2,
    )
    expect(entry?.title).toBe("PIN reset review")
  })

  it("gives a meeting the owner kept apart from both candidates an event of its own", async () => {
    const { store, zoom, path } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    const first = await zoomMeeting(store, zoom, "occ-1", at)
    const database = await openCache(path)
    database.prepare("UPDATE meetings SET event_id = NULL").run()
    await zoomMeeting(store, zoom, "occ-2", at)
    database.prepare("UPDATE meetings SET event_id = ? WHERE external_id = 'occ-1'").run(first.event?.id as number)
    database.close()
    const third = await zoomMeeting(store, zoom, "occ-3", at)
    expect(third.event).toBeNull()
    const [review] = await store.calendar.reviews({ status: "open" })
    expect(review?.linkableType).toBe("meeting")
    await store.calendar.resolveReview(review?.id as number, { apart: true }, 3)
    const linked = (await store.meetings.meeting(third.saved.meeting.id))?.meeting.eventId
    expect(linked).not.toBeNull()
    expect(review?.candidates).not.toContain(linked)
  })

  it("keeps no passcode, PIN or join-link query anywhere in the store", async () => {
    const { store, zoom, calendar, path } = await setup()
    const at = CONTRACT_NOW + 24 * HOUR
    await zoomMeeting(store, zoom, "occ-1", at)
    await store.calendar.saveEntries(
      calendar,
      [
        {
          externalId: "g1",
          kind: "single",
          status: "confirmed",
          title: "Planning",
          description: `<p>Join: <a href="https://example.zoom.us/j/81234567890?pwd=${PASSCODE}">link</a></p><p>Passcode: ${PASSCODE}</p><p>Dial-in PIN: ${PASSCODE}</p><p>Пароль: ${PASSCODE}</p><p>Код доступа ${PASSCODE}</p><p>Agenda: budget</p>`,
          location: `https://example.zoom.us/j/81234567890?pwd=${PASSCODE}`,
          startsAt: at,
          endsAt: at + HOUR,
          joinUrl: `https://example.zoom.us/j/81234567890?pwd=${PASSCODE}`,
          url: "https://www.google.com/calendar/event?eid=c3ludGhldGljLWV2ZW50",
          metadata: { conferenceData: { entryPoints: [{ passcode: PASSCODE }] }, colorId: "4", note: PASSCODE },
        },
      ],
      2,
    )
    const database = await openCache(path)
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(({ name }) => String(name))
    const found: string[] = []
    for (const table of tables) {
      const columns = database
        .prepare(`SELECT name, type FROM pragma_table_info('${table}')`)
        .all()
        .filter(({ type }) => String(type).toUpperCase() === "TEXT" || String(type) === "")
        .map(({ name }) => String(name))
      for (const column of columns)
        if (
          database
            .prepare(`SELECT 1 FROM "${table}" WHERE instr(lower("${column}"), lower(?)) > 0 LIMIT 1`)
            .get(PASSCODE)
        )
          found.push(`${table}.${column}`)
    }
    const kept = database.prepare("SELECT description, location, join_url, url, metadata FROM calendar_entries").get()
    database.close()
    // Zoom's own link, as zm saves it, still carries `pwd=` (RISK-1617); nothing the calendar wrote does.
    expect(found).toEqual(["meeting_series.join_url", "meetings.join_url"].filter((one) => found.includes(one)))
    expect(kept?.description).toBe("Join: https://example.zoom.us/j/81234567890 link\nAgenda: budget")
    expect(kept?.metadata).toBe('{"colorId":"4"}')
    expect(kept?.url).toBe("https://www.google.com/calendar/event?eid=c3ludGhldGljLWV2ZW50")
  })
})
