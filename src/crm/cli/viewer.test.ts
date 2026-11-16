import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
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
const ADMIN = "1"
const COLLEAGUE = "7"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Answer = Record<string, unknown> & { item: Record<string, unknown>; items: Record<string, unknown>[] }

/** An administrator's sync copies the whole account: one deal of the admin's, one of a colleague's, one of nobody's. */
const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-viewer-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  const database = await openCache(path)
  saveCrmSetting(database, crmSettingKey(PORTAL, "scope"), "all", 1)
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
    const source = fakeCrmSource({ ...(user ? { self: user } : {}), admin })
    source.put("person", examplePerson("pa", { email: "admin-client@example.com", phone: "+7 916 111-11-11" }))
    source.put("person", examplePerson("pc", { email: "own-client@example.com" }))
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
  const as = (user: string | undefined, admin = false) => {
    const key = `${user}:${admin}`
    const source = sources.get(key) ?? sourceOf(user, admin)
    sources.set(key, source)
    const run: CrmRun = { profile: "p", account: PORTAL, store, source: () => source, ...(user ? { user } : {}) }
    const cli = async (...args: string[]): Promise<Answer> => {
      let data = ""
      const root = new Command("crm")
        .exitOverride()
        .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
        .option("--json")
        .option("--offline")
      addCrmCommands(root, { app: APP, open: async () => run })
      provide(root, { streams: { data: (text: string) => (data += text), diagnostic: () => undefined } } as never)
      await root.parseAsync([...args, "--json"], { from: "user" })
      return JSON.parse(data) as Answer
    }
    return cli
  }
  await as(ADMIN, true)("sync")
  return { store, as }
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

  it("a profile whose user is unknown reads none of a copy that limits its users", async () => {
    const { as } = await setup()
    expect((await as(undefined)("deals", "list")).items).toEqual([])
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
})
