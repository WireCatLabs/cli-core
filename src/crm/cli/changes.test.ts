import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseReport } from "../../background/report/schema.js"
import { provide } from "../../cli/context.js"
import type { CrmActivity, CrmStageEntry } from "../../domain/crm.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { openCache } from "../../store/open.js"
import { crmSettingKey, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, exampleOrganization, examplePerson, fakeCrmSource, SALES_PIPELINE } from "../testing/index.js"
import { addCrmCommands, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PORTAL = { provider: "example-crm", account: "portal" }
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** The fake CRM stamps its changes from 2026-01-01; the clock stands a few hours after. */
const NOW = Date.UTC(2026, 0, 2, 9)
const WINDOW = "at>=2d"

const opened: MessageStore[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of opened.splice(0)) await store.close()
})

type Answer = Record<string, unknown> & {
  items: Record<string, unknown>[]
  page?: { has_more?: boolean; next_cursor?: string }
  next?: { args?: { cursor?: string } }[]
  notes: string[]
}

const activity = (externalId: string, on: CrmActivity["on"], fields: Partial<CrmActivity> = {}): CrmActivity => ({
  externalId,
  kind: "task",
  subject: `Example task ${externalId}`,
  body: "Call +34 600 123 456 about the contract",
  dueAt: null,
  done: false,
  assignee: "7",
  createdAt: NOW - 2 * HOUR,
  updatedAt: NOW - HOUR,
  on,
  ...fields,
})

/** A CRM with the shared fixtures, a clock the test moves, and the activities setting on. */
const setup = async (activities: CrmActivity[] = [], history: CrmStageEntry[] = []) => {
  const clock = { now: NOW }
  const path = join(mkdtempSync(join(tmpdir(), "crm-changes-")), "store.db")
  const store = await openStore({ path, now: () => clock.now })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const database = await openCache(path)
  saveCrmSetting(database, crmSettingKey(PORTAL, "activities"), "on", NOW)
  database.close()
  const source = fakeCrmSource({ activities, stageHistory: history })
  source.put("organization", exampleOrganization("c1"))
  source.put("person", examplePerson("p1", { createdAt: NOW - 3 * HOUR }))
  source.put(
    "deal",
    exampleDeal("d1", {
      title: "Example website",
      organization: "c1",
      people: [{ externalId: "p1", role: "contact" }],
      assignee: "7",
    }),
  )
  source.put("deal", exampleDeal("d2", { stage: "won" }))
  const run: CrmRun = { profile: "work", account: PORTAL, user: null, store, source: () => source }
  const call = async (args: string[]) => {
    let data = ""
    const notes: string[] = []
    const root = new Command("crm")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--offline")
    addCrmCommands(root, { app: APP, open: async () => run, activities: true, now: () => clock.now })
    provide(root, {
      streams: { data: (text: string) => (data += text), diagnostic: (text: string) => notes.push(text) },
    } as never)
    await root.parseAsync(args, { from: "user" })
    return { data, notes }
  }
  const cli = async (...args: string[]): Promise<Answer> => {
    const { data, notes } = await call([...args, "--json"])
    return { ...(JSON.parse(data) as Answer), notes }
  }
  const report = async (...args: string[]) => {
    const parsed = parseReport((await call(["changes", "list", ...args, "--format", "report"])).data, true)
    if (!parsed || "invalid" in parsed) throw new Error(`not a report: ${JSON.stringify(parsed)}`)
    return parsed.report
  }
  return { clock, source, store, cli, call, report }
}

const ids = (answer: Answer) => answer.items.map((one) => one.external_id)

describe("activities list", () => {
  it("lists open ones overdue first, then by due time, then undated; filters by due, owner and the row", async () => {
    const on = [{ kind: "deal" as const, externalId: "d1" }]
    const { cli, call } = await setup([
      activity("t0", on, { updatedAt: NOW - 3 * HOUR }),
      activity("t1", on, { dueAt: NOW - HOUR }),
      activity("t2", on, { dueAt: NOW + DAY, assignee: "9" }),
      activity("t3", on, { dueAt: NOW + 60_000 }),
      activity("o1", [{ kind: "organization", externalId: "c1" }], { updatedAt: NOW - 4 * HOUR }),
      activity("c1", [{ kind: "person", externalId: "p1" }], { kind: "call", done: true }),
    ])
    await cli("sync")
    expect(ids(await cli("activities", "list"))).toEqual(["t1", "t3", "t2", "t0", "o1"])
    expect(ids(await cli("activities", "list", "overdue:true"))).toEqual(["t1"])
    expect(ids(await cli("activities", "list", "overdue:false"))).toEqual(["t1", "t3", "t2", "t0", "o1"])
    expect(ids(await cli("activities", "list", "due:today"))).toEqual(["t1", "t3"])
    expect(ids(await cli("activities", "list", "owner:9"))).toEqual(["t2"])
    const d1 = (await cli("deals", "list")).items.find((one) => one.external_id === "d1") as {
      ref: string
      organization: { ref: string }
      people: { ref: string }[]
    }
    expect(ids(await cli("activities", "list", `deal:"${d1.ref}"`))).toEqual(["t1", "t3", "t2", "t0"])
    expect(ids(await cli("activities", "list", `organization:"${d1.organization.ref}"`))).toEqual(["o1"])
    const done = await cli("activities", "list", "status:done", `person:"${d1.people[0]?.ref}"`)
    expect(done.items).toEqual([
      expect.objectContaining({
        external_id: "c1",
        on: [{ kind: "person", external_id: "p1", ref: d1.people[0]?.ref, title: "Example person p1" }],
      }),
    ])
    await expect(
      call(["activities", "list", `deal:"${d1.ref}"`, `person:"${d1.people[0]?.ref}"`, "--json"]),
    ).rejects.toMatchObject({ code: "validation_error" })
  })
})

describe("changes list", () => {
  it("lists every kind of change in a fixed window, exact where the CRM's history gave the time", async () => {
    const { cli, call, source, clock } = await setup(
      [
        activity("t1", [{ kind: "deal", externalId: "d1" }], { dueAt: NOW - HOUR }),
        activity("c1", [{ kind: "person", externalId: "p1" }], { kind: "call", done: true }),
      ],
      [
        {
          externalId: "h1",
          kind: "deal",
          item: "d3",
          pipeline: SALES_PIPELINE.externalId,
          stage: "won",
          at: NOW - 4 * HOUR,
        },
      ],
    )
    source.put("deal", exampleDeal("d3", { stage: "won", amount: "10", currency: "EUR" }))
    source.put("deal", exampleDeal("d4", { stage: "lost", closedReason: "price" }))
    await cli("sync")
    source.put(
      "deal",
      exampleDeal("d1", {
        title: "Example website",
        organization: "c1",
        people: [{ externalId: "p1", role: "contact" }],
        assignee: "9",
        stage: "quote",
      }),
    )
    await cli("sync")

    const all = await cli("changes", "list", WINDOW)
    expect(new Set(all.items.map(({ change }) => change))).toEqual(
      new Set(["created", "moved", "won", "lost", "owner_changed", "activity_added", "activity_done", "person_added"]),
    )
    const won = all.items.filter(({ change }) => change === "won")
    expect(won.map(({ external_id, at, exact }) => [external_id, at, exact])).toEqual([
      ["d3", new Date(NOW - 4 * HOUR).toISOString(), true],
      ["d2", "2026-01-01T12:00:00.000Z", false],
    ])
    expect(all.items.find(({ change }) => change === "moved")).toMatchObject({
      title: "Example website",
      from: "New",
      to: "Quote sent",
      exact: false,
    })
    expect(all.items.find(({ change }) => change === "lost")).toMatchObject({ reason: "price" })
    expect(all.meta).toMatchObject({
      window: { since: new Date(NOW - 2 * DAY).toISOString(), until: new Date(NOW).toISOString() },
    })
    expect(JSON.stringify(all.items)).not.toContain("+34 600")
    const ats = all.items.map(({ at }) => at as string)
    expect(ats).toEqual([...ats].sort().reverse())

    expect(ids(await cli("changes", "list", WINDOW, "change:won"))).toEqual(["d3", "d2"])
    expect((await cli("changes", "list", WINDOW, "owner:none")).items.every(({ owner }) => owner === null)).toBe(true)
    expect((await cli("changes", "list", WINDOW, 'pipeline:"Example sales"')).items.length).toBeGreaterThan(0)
    await expect(call(["changes", "list", WINDOW, "pipeline:pipeline:999", "--json"])).rejects.toMatchObject({
      code: "not_found",
    })

    const first = await cli("changes", "list", WINDOW, "--limit", "2")
    expect(first.page?.has_more).toBe(true)
    const cursor = first.next?.[0]?.args?.cursor as string
    clock.now = NOW + HOUR
    source.put("deal", exampleDeal("d9"))
    await cli("sync")
    const second = await cli("changes", "list", WINDOW, "--limit", "2", "--cursor", cursor)
    expect([...first.items, ...second.items]).toEqual(all.items.slice(0, 4))

    const csv = (await call(["changes", "list", WINDOW, "--format", "csv"])).data
    expect(csv.split("\n")[0]).toContain("reason")
    expect(csv).toContain("price")
  })
})

describe("the CRM digest", () => {
  it("lists won and lost first, counts what it leaves out, and keeps a title such as follow_up", async () => {
    const tasks = Array.from({ length: 9 }, (_, at) =>
      activity(`t${at}`, [{ kind: "deal", externalId: "d1" }], { dueAt: NOW - HOUR - at }),
    )
    const { cli, source, report } = await setup(tasks)
    source.put("deal", exampleDeal("d3", { title: "follow_up", stage: "won", amount: "10", currency: "EUR" }))
    source.put("deal", exampleDeal("d4", { stage: "lost", closedReason: "price" }))
    for (let at = 10; at < 20; at += 1) source.put("deal", exampleDeal(`d${at}`))
    await cli("sync")
    const digest = await report(WINDOW)
    const [section] = digest.sections
    expect(section?.items.slice(0, 3).map(({ type, who, topic }) => [type, who ?? topic])).toEqual([
      ["money", "follow_up"],
      ["fact", "Example deal d2"],
      ["fact", "Example deal d4"],
    ])
    expect(section?.items[3]).toMatchObject({ type: "task", priority: "high" })
    // 3 closed + 9 overdue + 14 new deals + 1 new contacts line, 7 shown.
    expect(section?.more).toBe(3 + 9 + 14 + 1 - 7)
    expect(JSON.stringify(digest)).not.toContain("+34 600")
  })

  it("starts each scheduled run where the last one ended, so nothing shows twice", async () => {
    vi.stubEnv("CRM_SCHEDULED", "crm-digest")
    const { cli, source, report, clock } = await setup()
    await cli("sync")
    const first = await report(WINDOW)
    expect(first.sections[0]?.items.some(({ topic, who }) => (who ?? topic) === "Example deal d2")).toBe(true)
    clock.now = NOW + DAY
    source.put("person", examplePerson("p2", { createdAt: NOW + HOUR }))
    await cli("sync")
    const second = await report(WINDOW)
    expect(second.scope?.from).toBe(new Date(NOW + 1).toISOString())
    expect(second.sections[0]?.items).toEqual([expect.objectContaining({ count: 1 })])
  })

  it("names a failed last sync and a stale one in health, and an unsynced copy as an empty digest", async () => {
    const { cli, source, report, clock } = await setup()
    expect(await report(WINDOW)).toMatchObject({ sections: [], health: [] })
    await cli("sync")
    clock.now = NOW + 3 * DAY
    expect((await report(WINDOW)).health).toEqual([expect.objectContaining({ staleHours: 72 })])
    source.pipelines = async () => {
      throw new Error("the CRM is down")
    }
    await expect(cli("sync")).rejects.toThrow()
    expect((await report(WINDOW)).health).toEqual([
      expect.objectContaining({ reason: "sync-failed", since: new Date(NOW + 3 * DAY).toISOString() }),
    ])
  })
})
