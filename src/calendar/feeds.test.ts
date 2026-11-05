import { mkdtempSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { isStoreChange } from "../cli/effects.js"
import { maskArgv } from "../runs/run-context.js"
import type { GuardSettings } from "../sends/guard.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore, orphanPointers } from "../store/store.js"
import { type FeedRecord, fetchFeed, fetchFeedIfChanged, icsFeeds } from "./feeds.js"
import { calendarTestProgram } from "./testing/answers.js"
import { fakeCalendarSource, fakeCalendarWriter } from "./testing/index.js"

const NOW = Date.UTC(2026, 9, 27, 9)
const TOKEN = "s3cretFeedToken"
const ADDRESS = `https://calendar.example.com/private/${TOKEN}/basic.ics`
const app = { command: "gcal", appName: "gcal-cli", envPrefix: "GCAL", description: "synthetic", version: "1.0.0" }

const ics = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Example holidays", ...events, "END:VCALENDAR", ""].join("\r\n")

const HOLIDAY = [
  "BEGIN:VEVENT",
  "UID:holiday-1@example.com",
  "DTSTART;VALUE=DATE:20261101",
  "DTEND;VALUE=DATE:20261102",
  "SUMMARY:Example holiday",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
].join("\r\n")
const MATCH = [
  "BEGIN:VEVENT",
  "UID:match-1@example.com",
  "DTSTART:20261028T180000Z",
  "DTEND:20261028T200000Z",
  "SUMMARY:Example match",
  "END:VEVENT",
].join("\r\n")
const WEEKLY = [
  "BEGIN:VEVENT",
  "UID:weekly@example.com",
  "DTSTART;TZID=Europe/Madrid:20261020T100000",
  "DTEND;TZID=Europe/Madrid:20261020T103000",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "SUMMARY:Example weekly",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly@example.com",
  "RECURRENCE-ID;TZID=Europe/Madrid:20261027T100000",
  "DTSTART;TZID=Europe/Madrid:20261027T120000",
  "DTEND;TZID=Europe/Madrid:20261027T123000",
  "SUMMARY:Example weekly, moved",
  "END:VEVENT",
].join("\r\n")

const GUEST = [
  "BEGIN:VEVENT",
  "UID:guest-call@example.com",
  "DTSTART:20261029T150000Z",
  "DTEND:20261029T153000Z",
  "SUMMARY:Example call",
  "ORGANIZER;CN=Example Host:mailto:host.only.in.feed@example.com",
  "ATTENDEE;CN=Example Guest:mailto:guest.only.in.feed@example.com",
  "END:VEVENT",
].join("\r\n")

const servers: Server[] = []
const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const one of opened.splice(0)) await one.close()
})

const serve = async (handle: Parameters<typeof createServer>[1]) => {
  const server = createServer(handle)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("fetchFeed", () => {
  it("reads the feed, and names the feed but never its address when the server refuses", async () => {
    const base = await serve((request, response) => {
      if (request.url?.startsWith("/ok")) response.end(ics(MATCH))
      else response.writeHead(404).end()
    })
    expect(await fetchFeed(`${base}/ok/${TOKEN}`, { name: "feed 3" })).toContain("Example match")
    const refused = await fetchFeed(`${base}/missing/${TOKEN}`, { name: "feed 3" }).catch((error) => error)
    expect(refused).toMatchObject({ code: "not_found", message: "feed 3 answered HTTP 404" })
    expect(JSON.stringify(refused)).not.toContain(TOKEN)
  })

  it("follows a redirect only to https, and stops at its size and its time", async () => {
    const base = await serve((request, response) => {
      if (request.url === "/plain") response.writeHead(302, { location: "/elsewhere" }).end()
      else if (request.url === "/big") response.end("x".repeat(2048))
      else if (request.url === "/slow") setTimeout(() => response.end(ics()), 1000)
    })
    const limits = { maxBytes: 1024, timeoutMs: 200, redirects: 5 }
    await expect(fetchFeed(`${base}/plain`, { name: "feed 1", limits })).rejects.toMatchObject({
      details: { reason: "feed.redirect-refused" },
    })
    await expect(fetchFeed(`${base}/big`, { name: "feed 1", limits })).rejects.toMatchObject({
      details: { reason: "feed.too-large" },
    })
    await expect(fetchFeed(`${base}/slow`, { name: "feed 1", limits })).rejects.toMatchObject({
      code: "timeout",
      details: { reason: "feed.timeout" },
    })
    await expect(fetchFeed("ftp://example.com/feed.ics", { name: "feed 1" })).rejects.toMatchObject({
      details: { reason: "feed.address-invalid" },
    })
  })

  it("stops its time limit once the feed is read", async () => {
    let signal: AbortSignal | null | undefined
    const answer = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal
      return new Response(ics())
    }) as typeof fetch
    await fetchFeed("https://example.test/feed.ics", {
      name: "feed 1",
      fetch: answer,
      limits: { maxBytes: 4096, timeoutMs: 30, redirects: 5 },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(signal?.aborted).toBe(false)
  })

  it("sends the last ETag and Last-Modified back, and a 304 is unchanged with no body read", async () => {
    const asked: Record<string, string | undefined>[] = []
    const base = await serve((request, response) => {
      asked.push({ etag: request.headers["if-none-match"], since: request.headers["if-modified-since"] })
      if (request.url === "/tagged") {
        if (request.headers["if-none-match"] === '"v1"') response.writeHead(304).end()
        else response.writeHead(200, { etag: '"v1"' }).end(ics(MATCH))
      } else {
        const stamp = "Tue, 27 Oct 2026 08:00:00 GMT"
        if (request.headers["if-modified-since"] === stamp) response.writeHead(304).end()
        else response.writeHead(200, { "last-modified": stamp }).end(ics(MATCH))
      }
    })
    const first = await fetchFeedIfChanged(`${base}/tagged`, { name: "feed 1" })
    expect(first).toMatchObject({ validators: { etag: '"v1"', lastModified: null } })
    const since = (first as { validators: { etag: string | null; lastModified: string | null } }).validators
    expect(await fetchFeedIfChanged(`${base}/tagged`, { name: "feed 1", since })).toBe("unchanged")
    const dated = await fetchFeedIfChanged(`${base}/dated`, { name: "feed 2" })
    const later = (dated as { validators: { etag: string | null; lastModified: string | null } }).validators
    expect(later).toEqual({ etag: null, lastModified: "Tue, 27 Oct 2026 08:00:00 GMT" })
    expect(await fetchFeedIfChanged(`${base}/dated`, { name: "feed 2", since: later })).toBe("unchanged")
    expect(asked).toEqual([
      { etag: undefined, since: undefined },
      { etag: '"v1"', since: undefined },
      { etag: undefined, since: undefined },
      { etag: undefined, since: "Tue, 27 Oct 2026 08:00:00 GMT" },
    ])
  })

  it("reads webcal:// as https:// and follows an https redirect", async () => {
    const asked: string[] = []
    const fake = (async (url: URL) => {
      asked.push(url.href)
      return url.pathname === "/old"
        ? new Response(null, { status: 301, headers: { location: "https://feeds.example.com/new" } })
        : new Response(ics(MATCH))
    }) as unknown as typeof fetch
    await fetchFeed("webcal://feeds.example.com/old", { name: "feed 1", fetch: fake })
    expect(asked).toEqual(["https://feeds.example.com/old", "https://feeds.example.com/new"])
  })
})

const setup = async ({ realFetch = false } = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "calendar-feeds-")), "store.db")
  const store: MessageStore = await openStore({ path })
  opened.push(store)
  const account = { provider: "google-calendar", account: "owner-1" }
  const accountId = await store.accounts.saveAccount(account, { name: null })
  let saved: FeedRecord[] = []
  let served = ics(HOLIDAY, MATCH, WEEKLY)
  const asked: string[] = []
  const feeds = icsFeeds({
    registry: {
      read: async () => structuredClone(saved),
      write: async (feeds) => {
        saved = structuredClone(feeds)
      },
    },
    zone: "UTC",
    ...(realFetch
      ? {}
      : {
          fetch: (async (url: URL) => {
            asked.push(url.href)
            return new Response(served)
          }) as unknown as typeof fetch,
        }),
  })
  const source = fakeCalendarSource()
  const writer = fakeCalendarWriter()
  const home = mkdtempSync(join(tmpdir(), "calendar-feeds-home-"))
  const settings = (): GuardSettings => ({ profile: "work", permissions: {}, permissionSources: {}, sendsPerHour: 30 })
  let now = NOW
  const writes = { writer, app, settings, env: { HOME: home, GCAL_STATE_DIR: home } }
  const harness = calendarTestProgram(
    {
      profile: "work",
      store: store.calendar,
      accountId,
      account,
      messages: store,
      source: () => source,
      feeds: () => feeds,
      writes: () => writes,
    },
    { app, now: () => now, freeBusy: true, feeds: true, writes: {} },
  )
  const program = () => harness.root
  const cli = harness.cli
  const stderr = harness.stderr
  return {
    cli,
    program,
    writer,
    asked,
    source,
    stderr,
    path,
    saved: () => saved,
    later: (ms: number) => {
      now += ms
    },
    serve: (text: string) => {
      served = text
      now += 60_000
    },
  }
}

describe("feed calendars", () => {
  it("adds a feed, syncs its events beside the provider's, expands its series and keeps out of busy", async () => {
    const { cli, saved, asked } = await setup()
    const added = await cli("calendars", "add", ADDRESS.replace("https://", "webcal://"))
    expect(added).toMatchObject({ title: "Example holidays", access_role: "reader", synced: true, events: 4 })
    expect(JSON.stringify(added)).not.toContain(TOKEN)
    expect(saved()).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{12}$/u), url: ADDRESS, title: "Example holidays" }])
    const feed = String(added.id)

    const report = await cli("sync")
    expect(report).toMatchObject({ complete: true, feeds: [{ calendar_id: Number(feed), events: 4, skipped: 0 }] })
    expect(asked).toEqual([ADDRESS, ADDRESS])
    const events = (await cli("events", "list", `calendar:${feed}`, "starts_at>=2026-10-01")).items
    expect(events.map((one) => [one.title, one.starts_at])).toEqual(
      [
        ["Example weekly", "2026-10-20T08:00:00.000Z"],
        ["Example weekly, moved", "2026-10-27T11:00:00.000Z"],
        ["Example match", "2026-10-28T18:00:00.000Z"],
        ["Example weekly", "2026-11-03T09:00:00.000Z"],
        ["Example holiday", "2026-11-01T00:00:00.000Z"],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    )

    const busy = await cli("calendars", "busy", "starts_at>=2026-10-28", "ends_at<=2026-10-29")
    expect((busy.calendars as { calendar: string }[]).map((one) => one.calendar)).not.toContain(feed)
    await expect(cli("calendars", "busy", `calendar:${feed}`)).rejects.toMatchObject({
      details: { reason: "busy.feed" },
    })
    expect((await cli("calendars", "list")).items.map((one) => one.external_id)).toContain(`ics:${saved()[0]?.id}`)
  })

  it("refuses every write to a feed's events before the writer is asked", async () => {
    const { cli, writer } = await setup()
    const feed = String((await cli("calendars", "add", ADDRESS)).id)
    await cli("sync")
    const match = (await cli("events", "list", `calendar:${feed}`)).items.find((one) => one.title === "Example match")
    for (const args of [
      ["events", "delete", `event:${match?.id}`, "--yes"],
      ["events", "update", `event:${match?.id}`, "--title", "Mine", "--yes"],
      ["events", "respond", `event:${match?.id}`, "accepted", "--yes"],
      [
        "events",
        "create",
        feed,
        "--title",
        "Mine",
        "--start-time",
        "2026-11-02T10:00",
        "--end-time",
        "2026-11-02T11:00",
      ],
    ])
      await expect(cli(...args)).rejects.toMatchObject({
        code: "permission_error",
        details: { reason: "calendar.read-only" },
      })
    expect(writer.calls).toEqual([])
  })

  it("cancels an event the feed no longer holds on the next sync", async () => {
    const { cli, serve } = await setup()
    const feed = String((await cli("calendars", "add", ADDRESS, "--title", "Matches")).id)
    await cli("sync")
    serve(ics(HOLIDAY, WEEKLY))
    await cli("sync")
    const live = (await cli("events", "list", `calendar:${feed}`)).items
      .filter((one) => one.status !== "cancelled")
      .map((one) => one.title)
    expect(live).not.toContain("Example match")
    expect(live).toContain("Example holiday")
    await expect(cli("calendars", "add", ADDRESS)).rejects.toMatchObject({ details: { reason: "feed.duplicate" } })
  })

  it("calendars remove deletes the feed's events and what was built from them, and keeps a Google copy", async () => {
    const { cli, saved, serve, source, path } = await setup()
    source.put("primary", {
      externalId: "google-match",
      kind: "single",
      icalUid: "match-1@example.com",
      status: "confirmed",
      title: "Example match, my copy",
      startsAt: Date.UTC(2026, 9, 28, 18),
      endsAt: Date.UTC(2026, 9, 28, 20),
    })
    const feed = String((await cli("calendars", "add", ADDRESS, "--title", "Matches")).id)
    serve(ics(HOLIDAY, MATCH, WEEKLY, GUEST))
    await cli("sync")
    const db = await openCache(path)
    opened.push(db)
    const count = (sql: string) => Number(db.prepare(sql).get()?.n)
    const people = "SELECT count(*) AS n FROM identities WHERE external_id LIKE '%.only.in.feed@example.com'"
    expect(count(people)).toBe(2)
    const found = async () =>
      ((await cli("search", "events", "weekly")).items as { title: string }[]).map((one) => one.title)
    expect(await found()).not.toEqual([])

    const removed = await cli("calendars", "remove", "Matches")
    expect(removed).toMatchObject({ id: feed, synced: false, removed: expect.any(Number), events: 5 })
    expect(saved()).toEqual([])
    await expect(cli("events", "list", `calendar:${feed}`)).rejects.toMatchObject({ code: "not_found" })
    const left = (await cli("events", "list", "starts_at>=2026-10-01")).items
    expect(left.map((one) => [one.title, one.status])).toEqual([["Example match, my copy", "confirmed"]])
    expect(await found()).toEqual([])
    expect(count("SELECT count(*) AS n FROM event_words WHERE rowid NOT IN (SELECT id FROM events)")).toBe(0)
    expect(count(`SELECT count(*) AS n FROM calendar_entries WHERE calendar_id = ${Number(feed)}`)).toBe(0)
    expect(count(`SELECT count(*) AS n FROM calendars WHERE id = ${Number(feed)}`)).toBe(0)
    expect(count(`SELECT count(*) AS n FROM sync_cursors WHERE key = 'calendar:${Number(feed)}'`)).toBe(0)
    expect(count("SELECT count(*) AS n FROM events")).toBe(1)
    expect(count(people)).toBe(0)
    expect(orphanPointers(db).filter(({ count }) => count > 0)).toEqual([])
    await expect(cli("calendars", "remove", "primary")).rejects.toMatchObject({
      details: { reason: "feed.not-a-feed" },
    })
  })

  it("calendars unsync stops a Google calendar's sync and keeps its stored events as they are", async () => {
    const { cli, source } = await setup()
    source.put("primary", {
      externalId: "google-review",
      kind: "single",
      status: "confirmed",
      title: "Example review",
      startsAt: Date.UTC(2026, 9, 29, 10),
      endsAt: Date.UTC(2026, 9, 29, 11),
    })
    await cli("sync")
    const primary = (await cli("calendars", "list")).items.find((one) => one.external_id === "primary")
    expect(await cli("calendars", "unsync", String(primary?.id))).toMatchObject({ synced: false })
    source.remove("primary", "google-review")
    await cli("sync")
    expect(
      (await cli("events", "list", `calendar:${primary?.id}`)).items.map((one) => [one.title, one.status]),
    ).toEqual([["Example review", "confirmed"]])
  })

  it("asks a feed whether it changed, and a 304 keeps every stored event without reading it again", async () => {
    let body = ics(HOLIDAY, MATCH, WEEKLY)
    let version = 1
    const asked: (string | undefined)[] = []
    const base = await serve((request, response) => {
      asked.push(request.headers["if-none-match"])
      if (request.headers["if-none-match"] === `"v${version}"`) response.writeHead(304).end()
      else response.writeHead(200, { etag: `"v${version}"` }).end(body)
    })
    const { cli, later, stderr } = await setup({ realFetch: true })
    const feed = String((await cli("calendars", "add", `${base}/feed/${TOKEN}.ics`, "--title", "Matches")).id)
    expect(stderr.join("")).toContain("http://")
    expect(stderr.join("")).not.toContain(TOKEN)
    expect(stderr.filter((line) => line.includes("unencrypted"))).toHaveLength(1)
    const titles = async () =>
      (await cli("events", "list", `calendar:${feed}`)).items
        .filter((one) => one.status !== "cancelled")
        .map((one) => one.title)
    await cli("sync")
    const before = await titles()
    expect(before).toContain("Example match")

    later(3_600_000)
    const unchanged = await cli("sync")
    expect(unchanged).toMatchObject({ feeds: [{ calendar_id: Number(feed), events: 4, skipped: 0, unchanged: true }] })
    expect((unchanged.synced as { unseen: number }[]).every((one) => one.unseen === 0)).toBe(true)
    expect(await titles()).toEqual(before)

    body = ics(HOLIDAY, WEEKLY)
    version = 2
    later(3_600_000)
    await cli("sync")
    expect(await titles()).not.toContain("Example match")

    later(86_400_000)
    await cli("sync")
    expect(asked).toEqual([undefined, undefined, '"v1"', '"v1"', undefined])
  })

  it("does not warn about an https or webcal address", async () => {
    const { cli, stderr } = await setup()
    await cli("calendars", "add", ADDRESS.replace("https://", "webcal://"))
    expect(stderr).toEqual([])
  })

  it("keeps the address out of the run record and off MCP", async () => {
    const { program } = await setup()
    const root = program()
    const { argv } = maskArgv(root, ["calendars", "add", ADDRESS], { keep: true })
    expect(argv.join(" ")).not.toContain(TOKEN)
    const add = root.commands.find((one) => one.name() === "calendars")?.commands.find((one) => one.name() === "add")
    expect(metaOf(add as Command)).toMatchObject({ mcp: false })
    expect(isStoreChange(add as Command)).toBe(true)
  })
})
