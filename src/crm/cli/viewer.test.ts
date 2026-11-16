import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
import type { CrmActivity } from "../../domain/crm.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { openCache } from "../../store/open.js"
import { crmSettingKey, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, examplePerson, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PORTAL = { provider: "example-crm", account: "portal" }
const OTHER = { provider: "example-crm", account: "other" }
const ADMIN = "1"
const COLLEAGUE = "7"

const task = (externalId: string, subject: string, on: CrmActivity["on"], assignee: string): CrmActivity => ({
  externalId,
  kind: "task",
  subject,
  body: null,
  dueAt: Date.UTC(2026, 0, 1),
  done: false,
  assignee,
  createdAt: Date.UTC(2026, 0, 1),
  // The sync reads activities changed in the last 90 days.
  updatedAt: Date.now(),
  on,
})
/** One task on each user's deal, and one call on the administrator's client alone. */
const ACTIVITIES = [
  task("ta", "Harbour call", [{ kind: "deal", externalId: "da" }], ADMIN),
  task("tc", "Lighthouse call", [{ kind: "deal", externalId: "dc" }], COLLEAGUE),
  task("tp", "Harbour client call", [{ kind: "person", externalId: "pa" }], ADMIN),
]
const WINDOW = "at>=2025-12-01"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Answer = Record<string, unknown> & {
  item: Record<string, unknown>
  items: Record<string, unknown>[]
  meta?: { complete?: boolean }
  notes: string[]
}

/** An administrator's sync copies the whole account: one deal of the admin's, one of a colleague's, one of nobody's. */
const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-viewer-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  const database = await openCache(path)
  saveCrmSetting(database, crmSettingKey(PORTAL, "scope"), "all", 1)
  saveCrmSetting(database, crmSettingKey(OTHER, "scope"), "all", 1)
  saveCrmSetting(database, crmSettingKey(PORTAL, "activities"), "on", 1)
  database.close()
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const sources = new Map<string, ReturnType<typeof fakeCrmSource>>()
  const sourceOf = (user: string | undefined, admin: boolean) => {
    const source = fakeCrmSource({ ...(user ? { self: user } : {}), admin, activities: ACTIVITIES })
    const added = { createdAt: Date.UTC(2026, 0, 1) }
    source.put(
      "person",
      examplePerson("pa", { email: "admin-client@example.com", phone: "+7 916 111-11-11", ...added }),
    )
    source.put("person", examplePerson("pc", { email: "own-client@example.com", ...added }))
    source.put(
      "deal",
      exampleDeal("da", {
        title: "Harbour",
        assignee: ADMIN,
        amount: "900",
        currency: "EUR",
        people: [{ externalId: "pa", role: "contact" }],
      }),
    )
    source.put(
      "deal",
      exampleDeal("dc", {
        title: "Lighthouse",
        assignee: COLLEAGUE,
        amount: "100",
        currency: "EUR",
        people: [{ externalId: "pc", role: "contact" }],
      }),
    )
    source.put("deal", exampleDeal("dn", { title: "Nobody's", amount: "50", currency: "EUR" }))
    return source
  }
  const as = (user: string | undefined, admin = false, account = PORTAL) => {
    const key = `${user}:${admin}:${account.account}`
    const source = sources.get(key) ?? sourceOf(user, admin)
    sources.set(key, source)
    const run: CrmRun = { profile: "p", account, store, source: () => source, user: user ?? null }
    const cli = async (...args: string[]): Promise<Answer> => {
      let data = ""
      const notes: string[] = []
      const root = new Command("crm")
        .exitOverride()
        .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
        .option("--json")
        .option("--offline")
      addCrmCommands(root, { app: APP, open: async () => run, activities: true })
      provide(root, {
        streams: { data: (text: string) => (data += text), diagnostic: (text: string) => notes.push(text) },
      } as never)
      await root.parseAsync([...args, ...(args.includes("--format") ? [] : ["--json"])], { from: "user" })
      return args.includes("--format")
        ? ({ printed: data, notes } as never)
        : { ...(JSON.parse(data) as Answer), notes }
    }
    return cli
  }
  await as(ADMIN, true)("sync")
  return { store, as, path, adminSource: () => sources.get(`${ADMIN}:true:portal`) as ReturnType<typeof fakeCrmSource> }
}

const titles = (answer: Answer) => answer.items.map((one) => one.title).sort()

describe("offline reads of a copy another profile synced (SEC-197)", () => {
  it("the administrator who synced it reads the whole copy", async () => {
    const { as } = await setup()
    expect(titles(await as(ADMIN, true)("deals", "list"))).toEqual(["Harbour", "Lighthouse", "Nobody's"])
  })

  it("a colleague's profile lists only the deals assigned to its user", async () => {
    const { as } = await setup()
    const colleague = as(COLLEAGUE)
    expect(titles(await colleague("deals", "list"))).toEqual(["Lighthouse"])
    expect(titles(await colleague("deals", "list", "owner:me"))).toEqual(["Lighthouse"])
    expect(titles(await colleague("deals", "list", `owner:${ADMIN}`))).toEqual([])
    expect(titles(await colleague("deals", "list", "owner:none"))).toEqual([])
  })

  it("a colleague's profile cannot show the administrator's deal", async () => {
    const { as } = await setup()
    const all = await as(ADMIN, true)("deals", "list")
    const harbour = all.items.find((one) => one.title === "Harbour")?.ref as string
    await expect(as(COLLEAGUE)("deals", "show", harbour)).rejects.toMatchObject({ code: "not_found" })
    const lighthouse = all.items.find((one) => one.title === "Lighthouse")?.ref as string
    expect((await as(COLLEAGUE)("deals", "show", lighthouse)).item).toMatchObject({ title: "Lighthouse" })
  })

  it("search all never finds another user's deal by its client's e-mail or phone", async () => {
    const { as } = await setup()
    const colleague = as(COLLEAGUE)
    for (const words of [["admin-client@example.com"], ["79161111111"], ["Harbour"]]) {
      expect((await colleague("search", "all", ...words, "--only", "crm")).items).toEqual([])
      expect(JSON.stringify((await colleague("search", "all", ...words)).items)).not.toMatch(/Harbour|person pa/)
    }
    expect((await colleague("search", "all", "own-client@example.com", "--only", "crm")).items).toEqual([
      expect.objectContaining({ title: "Lighthouse" }),
    ])
    expect((await as(ADMIN, true)("search", "all", "admin-client@example.com", "--only", "crm")).items).toHaveLength(1)
  })

  it("pipeline and stage reports count only the deals the profile may read", async () => {
    const { as } = await setup()
    const colleague = as(COLLEAGUE)
    const pipelines = await colleague("pipelines", "list")
    const deal = pipelines.items.find((one) => one.kind === "deal") as { ref: string; stages: { open: number }[] }
    expect(deal.stages.reduce((sum, one) => sum + one.open, 0)).toBe(1)
    const report = (await colleague("pipelines", "show", deal.ref)).item as {
      totals: { items: number }
      stages: { items: number; amounts: { amount: string }[] }[]
      owners: { assignee: string | null }[]
    }
    expect(report.totals.items).toBe(1)
    expect(report.stages.flatMap((one) => one.amounts.map(({ amount }) => amount))).toEqual(["100.00"])
    expect(report.owners.map(({ assignee }) => assignee)).toEqual(["portal/user/7"])
    const stages = await colleague("stages", "list", "kind:deal")
    expect(stages.items.reduce((sum, one) => sum + Number(one.open), 0)).toBe(1)
    const admin = (await as(ADMIN, true)("pipelines", "show", deal.ref)).item as { totals: { items: number } }
    expect(admin.totals.items).toBe(3)
  })

  it("a profile whose user is unknown reads none of a copy that limits its users, and says why", async () => {
    const { as } = await setup()
    const listed = await as(undefined)("deals", "list")
    expect(listed.items).toEqual([])
    expect(listed.meta?.complete).toBe(false)
    expect(listed.notes.join("")).toContain("names no CRM user")
    const all = await as(ADMIN, true)("deals", "list")
    for (const title of ["Harbour", "Nobody's"]) {
      const ref = all.items.find((one) => one.title === title)?.ref as string
      await expect(as(undefined)("deals", "show", ref)).rejects.toMatchObject({ code: "not_found" })
    }
  })

  it("a copy no sync of this version recorded shows a known user only its own deals, and says to sync", async () => {
    const { as, store } = await setup()
    await store.sync.setSyncState(PORTAL, "crm:viewers", "null")
    const listed = await as(ADMIN, true)("deals", "list")
    expect(titles(listed)).toEqual(["Harbour"])
    expect(listed.meta?.complete).toBe(false)
    expect(listed.notes.join("")).toContain("run sync once")
    const nobody = (await store.deals.list({ kind: "deal", account: PORTAL })).items.find(
      (one) => one.title === "Nobody's",
    )
    await expect(as(ADMIN, true)("deals", "show", nobody?.ref as string)).rejects.toMatchObject({ code: "not_found" })
  })

  it("search all without a lock reads another account's copy only as that copy's own rule allows", async () => {
    const { as, store } = await setup()
    await as(ADMIN, true, OTHER)("sync")
    const asked = ["search", "all", "admin-client@example.com", "--only", "crm"]
    const accounts = (answer: Answer) => answer.items.map((one) => one.account).sort()
    expect(accounts(await as(ADMIN, true)(...asked))).toEqual(["other", "portal"])
    expect((await as(COLLEAGUE)(...asked)).items).toEqual([])
    await store.sync.setSyncState(OTHER, "crm:viewers", "null")
    expect(accounts(await as(ADMIN, true)(...asked))).toEqual(["other", "portal"])
    await store.crm.saveOwnUser(OTHER, COLLEAGUE)
    expect(accounts(await as(ADMIN, true)(...asked))).toEqual(["portal"])
  })

  it("store status tells a limited profile its counts are the whole copy's", async () => {
    const { as } = await setup()
    expect((await as(COLLEAGUE)("store", "status")).notes.join("")).toContain("whole copy")
    expect((await as(ADMIN, true)("store", "status")).notes.join("")).not.toContain("whole copy")
  })

  it("an administrator on the same account reads it whole once a sync of its own learned it is one", async () => {
    const { as } = await setup()
    const other = as("9", true)
    expect(titles(await other("deals", "list"))).toEqual([])
    // The copy is user 1's, so this sync is refused, but it records that user 9 is the CRM's administrator.
    await expect(other("sync")).rejects.toMatchObject({ code: "validation_error" })
    expect(titles(await other("deals", "list"))).toEqual(["Harbour", "Lighthouse", "Nobody's"])
  })

  it("a sync that finds the user no longer an administrator narrows its reads again", async () => {
    const { as } = await setup()
    await as(ADMIN, false)("sync")
    expect(titles(await as(ADMIN, false)("deals", "list"))).toEqual(["Harbour"])
  })

  it("changes, activities and the digest show a colleague only its own deals, their tasks and their clients", async () => {
    const { as } = await setup()
    const colleague = as(COLLEAGUE)
    const changes = await colleague("changes", "list", WINDOW)
    expect(JSON.stringify(changes.items)).not.toMatch(/Harbour|person pa|"pa"|"ta"|"tp"/)
    expect(changes.items.filter((one) => one.change === "person_added").map((one) => one.external_id)).toEqual(["pc"])
    expect(changes.items.filter((one) => one.change === "activity_added").map((one) => one.external_id)).toEqual(["dc"])
    expect((await colleague("activities", "list")).items.map((one) => one.external_id)).toEqual(["tc"])
    const harbour = (await as(ADMIN, true)("deals", "list")).items.find((one) => one.title === "Harbour")?.ref
    expect((await colleague("activities", "list", `deal:"${harbour}"`)).items).toEqual([])
    const shared = await colleague("activities", "list", "status:open")
    expect(JSON.stringify(shared.items)).not.toContain("Harbour")
    for (const format of ["csv", "report"]) {
      const { printed } = (await colleague("changes", "list", WINDOW, "--format", format)) as unknown as {
        printed: string
      }
      expect(printed).toContain("Lighthouse")
      expect(printed).not.toMatch(/Harbour/)
    }
    expect((await as(ADMIN, true)("activities", "list")).items.map((one) => one.external_id).sort()).toEqual([
      "ta",
      "tc",
      "tp",
    ])
  })

  it("changes and activities of a profile whose user is unknown are empty, incomplete and say why", async () => {
    const { as } = await setup()
    const nobody = as(undefined)
    for (const args of [
      ["changes", "list", WINDOW],
      ["activities", "list"],
    ]) {
      const answer = await nobody(...args)
      expect(answer.items).toEqual([])
      expect(answer.meta?.complete).toBe(false)
      expect(answer.notes.join("")).toContain("names no CRM user")
    }
    for (const format of ["csv", "report"]) {
      const answer = (await nobody("changes", "list", WINDOW, "--format", format)) as unknown as {
        printed: string
        notes: string[]
      }
      expect(answer.printed).not.toMatch(/Harbour|Lighthouse/)
      expect(answer.notes.join("")).toContain("names no CRM user")
    }
  })

  it("the digest of a colleague leaves out the tasks stage rules opened on deals it may not read (SEC-198)", async () => {
    const { as, path, adminSource } = await setup()
    const database = await openCache(path)
    saveCrmSetting(
      database,
      crmSettingKey(PORTAL, "stage-tasks"),
      { quote: { title: "Send the quote", due_days: 2 } },
      1,
    )
    database.close()
    const source = adminSource()
    source.put("deal", exampleDeal("da", { title: "Harbour", assignee: ADMIN, stage: "quote" }))
    source.put("deal", exampleDeal("dc", { title: "Lighthouse", assignee: COLLEAGUE, stage: "quote" }))
    const admin = as(ADMIN, true)
    await admin("sync")
    const report = (await as(COLLEAGUE)("changes", "list", WINDOW, "--format", "report")) as unknown as {
      printed: string
    }
    const tasks = (
      JSON.parse(report.printed) as { sections: { items: { topic: string }[] }[] }
    ).sections[0]?.items.filter((one) => one.topic === "Send the quote")
    expect(tasks).toHaveLength(1)
  })
})
