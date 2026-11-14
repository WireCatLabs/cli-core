import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterAll, describe, expect, it } from "vitest"
import { addCalendarCommands } from "../calendar/cli/index.js"
import { callCalendarTool } from "../calendar/mcp/index.js"
import { fakeCalendarSource, memoryEventStore } from "../calendar/testing/index.js"
import {
  addMeetingCommands,
  addMeetingSearchCommand,
  type MeetingCommandDeps,
  type MeetingHitSearchOptions,
} from "../meetings/cli/index.js"
import { callMeetingSearchTool, callMeetingTool } from "../meetings/mcp/index.js"
import { memoryMeetingStore, sampleMeeting } from "../meetings/testing/index.js"
import type { AppIdentity } from "../ports/app.js"
import { type MessageStore, openStore } from "../store/store.js"
import { inCommandRun, outputFor } from "./context.js"
import { type Body, renderAnswer } from "./envelope.js"
import { pagingOf } from "./paging.js"
import { type ProgramDefinition, run } from "./program.js"
import { settingsFor } from "./settings.js"

const app: AppIdentity = {
  command: "listing",
  appName: "listing-test",
  envPrefix: "LISTING",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}
const HOUR = 3_600_000

const homeWith = (limit?: number) => {
  const home = mkdtempSync(join(tmpdir(), "listing-"))
  const config = join(home, "config")
  mkdirSync(config)
  if (limit !== undefined) writeFileSync(join(config, "config.json"), JSON.stringify({ defaults: { limit } }))
  return { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, LISTING_CONFIG_DIR: config }
}

const cliOf =
  (definition: ProgramDefinition) =>
  async (env: NodeJS.ProcessEnv, ...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, definition, { streams, env, tty: false })
    const out = streams.stdout.join("")
    if (code !== 0) throw new Error(`exit ${code}: ${streams.stderr.join("\n")}`)
    return JSON.parse(out)
  }

describe("meetings list pages as the shared listings do", () => {
  const store = memoryMeetingStore()
  let running: Command | undefined
  const meetings = (): Command[] => {
    const root = new Command(app.command)
    addMeetingCommands(root, {
      store,
      accountId: 1,
      write: (value) => {
        if (running) renderAnswer(running, outputFor(running), value as Body)
      },
      inRun: (command, body) => {
        running = command
        return inCommandRun(command, body)
      },
      pagingOf,
    })
    return [...root.commands]
  }
  const cli = cliOf({ app, configuration: settingsFor(app), commands: meetings })
  const seeded = (async () => {
    for (let index = 0; index < 3; index++) {
      const meeting = sampleMeeting()
      await store.saveMeeting({
        ...meeting,
        meeting: { ...meeting.meeting, externalId: `m-${index}`, title: `Example meeting ${index}` },
      })
    }
  })()

  it("shows the profile's defaults.limit when --limit is not given, and --limit over it", async () => {
    await seeded
    const env = homeWith(2)
    const configured = await cli(env, "work", "meetings", "list", "--offline", "--json")
    expect(configured.items).toHaveLength(2)
    expect(configured.page).toMatchObject({ limit: 2, has_more: true, next_page: 2 })
    expect((await cli(env, "work", "meetings", "list", "--offline", "--page", "2", "--json")).items).toHaveLength(1)
    expect((await cli(env, "work", "meetings", "list", "--offline", "--limit", "3", "--json")).page.limit).toBe(3)
  })

  it("--json id,title keeps those fields, through the program's own --json", async () => {
    await seeded
    const picked = await cli(homeWith(), "work", "meetings", "list", "--offline", "--json", "id,title")
    expect(Object.keys(picked.items[0]).sort()).toEqual(["id", "title"])
    const leaves = meetings()
      .flatMap((group) => group.commands)
      .filter((leaf) => leaf.options.some((option) => option.long === "--json" || option.long === "--jsonl"))
    expect(leaves.map((leaf) => leaf.name())).toEqual([])
  })
})

describe("calendar lists page as the shared listings do", () => {
  const NOW = Date.UTC(2026, 9, 27, 9)
  const account = { provider: "google-calendar", account: "owner@example.com" }
  const source = fakeCalendarSource({
    calendars: [
      {
        externalId: "primary",
        title: "Work",
        timezone: "UTC",
        accessRole: "owner",
        primary: true,
        syncByDefault: true,
      },
    ],
  })
  source.put(
    "primary",
    ...[0, 1, 2].map((index) => ({
      externalId: `e${index}`,
      kind: "single" as const,
      status: "confirmed" as const,
      title: `Example roadmap planning ${index}`,
      startsAt: NOW + (index + 1) * HOUR,
      endsAt: NOW + (index + 2) * HOUR,
      participants: [],
    })),
  )
  let store: MessageStore
  let accountId = 0
  const opening = (async () => {
    store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "listing-calendar-")), "store.db") })
    await store.accounts.registerProvider({ name: "google-calendar", kind: "events", aliases: [], command: "gcal" })
    accountId = await store.accounts.saveAccount(account, { name: null })
  })()
  afterAll(async () => {
    await opening
    await store.close()
  })
  const cli = cliOf({
    app,
    configuration: settingsFor(app),
    commands: () => {
      const root = new Command(app.command)
      addCalendarCommands(root, {
        app,
        now: () => NOW,
        timezone: "UTC",
        open: async () => ({
          profile: "work",
          account,
          accountId,
          store: store.calendar,
          messages: store,
          source: () => source,
        }),
      })
      return [...root.commands]
    },
  })

  it("events list and search events show the profile's defaults.limit when --limit is not given", async () => {
    await opening
    const env = homeWith(2)
    await cli(env, "work", "sync", "--json")
    const listed = await cli(env, "work", "events", "list", "--json")
    expect(listed.items).toHaveLength(2)
    expect(listed.page).toMatchObject({ limit: 2, has_more: true })
    expect((await cli(env, "work", "events", "list", "--limit", "3", "--json")).items).toHaveLength(3)
    const found = await cli(env, "work", "search", "events", "roadmap", "--exact", "--json")
    expect(found.items).toHaveLength(2)
    expect(found.page).toMatchObject({ mode: "cursor", limit: 2, has_more: true, next_cursor: "2" })
    const next = await cli(env, "work", "search", "events", "roadmap", "--exact", "--cursor", "2", "--json")
    expect(next.items).toHaveLength(1)
    expect(next.page).toMatchObject({ has_more: false })
  })
})

describe("search meetings and the MCP lists take the configured limit", () => {
  const empty = {
    items: [],
    hasMore: false,
    nextCursor: null,
    coverage: {
      archiveCompleteness: "unknown" as const,
      currentRevisions: true as const,
      indexing: "ready" as const,
      indexCompleteness: "unknown" as const,
    },
  }

  it("search meetings asks for the profile's defaults.limit when --limit is not given", async () => {
    const asked: MeetingHitSearchOptions[] = []
    let running: Command | undefined
    const cli = cliOf({
      app,
      configuration: settingsFor(app),
      commands: () => {
        const root = new Command(app.command)
        addMeetingSearchCommand(root, {
          search: async (_query, request) => {
            asked.push(request)
            return empty
          },
          signal: () => undefined,
          pagingOf: (command) => {
            running = command
            return pagingOf(command)
          },
          output: (value) => {
            if (running) renderAnswer(running, outputFor(running), value as Body)
          },
        })
        return [...root.commands]
      },
    })
    const env = homeWith(2)
    expect((await cli(env, "work", "search", "meetings", "budget", "--json")).page.limit).toBe(2)
    expect(asked[0]?.limit).toBe(2)
    await cli(env, "work", "search", "meetings", "budget", "--limit", "5", "--json")
    expect(asked[1]?.limit).toBe(5)
  })

  it("meetings_list, events_list and the meeting search tool page by the limit the host passes", async () => {
    const meetings = await callMeetingTool(memoryMeetingStore(), "meetings_list", {}, { limit: 2 })
    expect(meetings.structuredContent).toMatchObject({ page: { limit: 2 } })
    const events = await callCalendarTool(memoryEventStore(), "events_list", {}, { accountIds: [1], limit: 2 })
    expect(events.structuredContent).toMatchObject({ page: { limit: 2 } })
    const found = await callMeetingSearchTool(async () => empty, { query: "budget" }, { limit: 2 })
    expect(found.structuredContent).toMatchObject({ page: { limit: 2 } })
  })

  it("a host must pass pagingOf to the meetings commands", () => {
    const deps: Omit<MeetingCommandDeps, "pagingOf"> = {
      store: memoryMeetingStore(),
      accountId: 1,
      write: () => {},
      inRun: (_command, body) => body(),
    }
    // @ts-expect-error pagingOf is required: without it a configured limit never reaches meetings list
    addMeetingCommands(new Command(), deps)
  })
})
