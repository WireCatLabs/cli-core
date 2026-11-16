import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "../../store/open.js"
import { crmSettingKey, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../../store/store.js"
import {
  crmSourceContract,
  crmSyncContract,
  crmWriteContract,
  exampleDeal,
  exampleLead,
  exampleOrganization,
  examplePerson,
  FAKE_CRM_ALIASES,
  fakeCrmSource,
  SALES_PIPELINE,
} from "./index.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

describe("sync engine over a store", () => {
  for (const c of crmSyncContract(async () => {
    const path = join(mkdtempSync(join(tmpdir(), "crm-sync-")), "store.db")
    const store = await openStore({ path })
    stores.push(store)
    const account = { provider: "example-crm", account: "portal" }
    const activitiesOn = async () => {
      const database = await openCache(path)
      saveCrmSetting(database, crmSettingKey(account, "activities"), "on", Date.now())
      database.close()
    }
    return { store, account, activitiesOn }
  }))
    it(c.name, c.run)
})

describe("fake CRM source", () => {
  for (const removedInChanges of [false, true])
    for (const c of crmSourceContract(async () => {
      const source = fakeCrmSource({ traits: { removedInChanges } })
      source.put("organization", exampleOrganization("c1"))
      for (const id of ["p1", "p2", "p3"]) source.put("person", examplePerson(id))
      for (const id of ["d1", "d2", "d3"]) source.put("deal", exampleDeal(id, { amount: "10.50", currency: "EUR" }))
      source.put("lead", exampleLead("l1"))
      const { cursor } = (await source.changes("deal", null, "2")) as { cursor: string }
      source.put("deal", exampleDeal("d4"))
      source.expireCursors("deal")
      return {
        source,
        deadCursor: { kind: "deal", cursor },
        live: { person: ["p1", "p2", "p3"], organization: ["c1"] },
        faults: {
          deny: () => {
            source.deny("person", "p2")
            return { kind: "person", id: "p2" }
          },
          skewed: () => source,
          change: () => {
            source.put("deal", exampleDeal("d1", { title: "Changed" }))
            return { kind: "deal", id: "d1" }
          },
          sameToken: () => source,
        },
      }
    }))
      it(`${c.name} (removedInChanges: ${removedInChanges})`, c.run)
})

describe("the source contract's live case", () => {
  const liveCase = (setup: (source: ReturnType<typeof fakeCrmSource>) => void) => {
    const found = crmSourceContract(() => {
      const source = fakeCrmSource()
      for (const id of ["p1", "p2"]) source.put("person", examplePerson(id, { phones: [`+3460000000${id.slice(1)}`] }))
      source.put("organization", exampleOrganization("c1"))
      setup(source)
      return { source, live: { person: ["p1", "p2", "p3"], organization: ["c1"] } }
    }).find(({ name }) => name.startsWith("list and get:"))
    if (!found) throw new Error("the contract has no live case")
    return found.run()
  }

  it("fails a source that loses a record between its pages (FIND-2668)", async () => {
    await expect(liveCase(() => undefined)).rejects.toThrow(/none lost/)
  })

  it("fails a source that repeats a phone in provider_metadata (SEC-2)", async () => {
    await expect(
      liveCase((source) =>
        source.put(
          "person",
          examplePerson("p3", {
            phones: ["+34600000003"],
            metadata: { CELL: { label: "Cell", value: "+34600000003" } },
          }),
        ),
      ),
    ).rejects.toThrow(/provider_metadata repeats/)
  })
})

describe("the source contract's self case", () => {
  const selfCase = (assignee?: string) => {
    const found = crmSourceContract(() => {
      const source = fakeCrmSource({ self: "7" })
      source.put("deal", exampleDeal("d1", assignee ? { assignee } : {}))
      return { source }
    }).find(({ name }) => name.startsWith("self:"))
    if (!found) throw new Error("the contract has no self case")
    return found.run()
  }

  it("fails a source that names its own user but leaves a deal without an assignee", async () => {
    await expect(selfCase()).rejects.toThrow(/d1 has an assignee/)
  })

  it("passes one that gives every deal an assignee", async () => {
    await expect(selfCase("9")).resolves.toBeUndefined()
  })
})

describe("fake CRM writer", () => {
  for (const idempotent of [false, true])
    for (const c of crmWriteContract(() => {
      const source = fakeCrmSource({ capabilities: { idempotent } })
      return {
        writer: source,
        pipeline: SALES_PIPELINE,
        aliases: FAKE_CRM_ALIASES,
        loseNextAnswer: () => source.loseNextAnswer(),
        requests: () => source.writes.length,
      }
    }))
      it(`${c.name} (idempotent: ${idempotent})`, c.run)
})
