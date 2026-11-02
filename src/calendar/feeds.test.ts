import { mkdtempSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { isStoreChange } from "../cli/effects.js"
import { maskArgv } from "../runs/run-context.js"
import type { GuardSettings } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { addCalendarCommands } from "./cli/index.js"
import { type FeedRecord, fetchFeed, icsFeeds } from "./feeds.js"
import { checkCalendarAnswer } from "./testing/answers.js"
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

const servers: Server[] = []
const opened: MessageStore[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const store of opened.splice(0)) await store.close()
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

const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "calendar-feeds-")), "store.db") })
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
    fetch: (async (url: URL) => {
      asked.push(url.href)
      return new Response(served)
    }) as unknown as typeof fetch,
  })
  const writer = fakeCalendarWriter()
  const home = mkdtempSync(join(tmpdir(), "calendar-feeds-home-"))
  const settings = (): GuardSettings => ({ profile: "work", permissions: {}, permissionSources: {}, sendsPerHour: 30 })
  const written: Record<string, unknown>[] = []
  let now = NOW
  const program = () => {
    const root = new Command("gcal").exitOverride().configureOutput({ writeErr: () => undefined })
    root.option("--yes").option("--json").option("--jsonl").option("--offline")
    addCalendarCommands(root, {
      store: store.calendar,
      accountId,
      account,
      source: fakeCalendarSource(),
      freeBusy: true,
      feeds,
      write: (value) => written.push(value as Record<string, unknown>),
      now: () => now,
      timezone: "UTC",
      writes: { writer, app, settings, env: { HOME: home, GCAL_STATE_DIR: home } },
    })
    return root
  }
  const cli = async (...args: string[]) => {
    const root = program()
    const before = written.length
    await root.parseAsync(args, { from: "user" })
    if (written.length > before) checkCalendarAnswer(root, args, written.at(-1))
    return written.at(-1) as Record<string, unknown> & { items: Record<string, unknown>[] }
  }
  return {
    cli,
    program,
    writer,
    asked,
    saved: () => saved,
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
    expect(report).toMatchObject({ complete: true, feeds: [{ calendarId: Number(feed), events: 4, skipped: 0 }] })
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

    const busy = await cli("calendars", "busy", "start>=2026-10-28", "end<=2026-10-29")
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

  it("drops an event the feed no longer holds, and calendars remove forgets the feed and its events", async () => {
    const { cli, saved, serve } = await setup()
    const feed = String((await cli("calendars", "add", ADDRESS, "--title", "Matches")).id)
    await cli("sync")
    serve(ics(HOLIDAY, WEEKLY))
    await cli("sync")
    const live = async () =>
      (await cli("events", "list", `calendar:${feed}`)).items
        .filter((one) => one.status !== "cancelled")
        .map((one) => one.title)
    expect(await live()).not.toContain("Example match")
    expect(await live()).toContain("Example holiday")
    await expect(cli("calendars", "add", ADDRESS)).rejects.toMatchObject({ details: { reason: "feed.duplicate" } })
    const removed = await cli("calendars", "remove", "Matches")
    expect(removed).toMatchObject({ id: feed, synced: false, removed: 5 })
    expect(saved()).toEqual([])
    expect(await live()).toEqual([])
    await expect(cli("calendars", "remove", "primary")).rejects.toMatchObject({
      details: { reason: "feed.not-a-feed" },
    })
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
