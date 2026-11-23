import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ingest } from "../services/ingest.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const upsert = (type: string, externalId: string, fields: Record<string, unknown>, relations?: unknown[]) => ({
  key: `${type}-${externalId}`,
  type,
  external_id: externalId,
  operation: "upsert" as const,
  fields,
  ...(relations === undefined ? {} : { relations }),
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "organization-erase-")), "store.db") })
  handles.push(store)
  const send = async (account: string, company: string, deal: string) => {
    await ingest(
      store,
      {
        schema_version: 1,
        source: { provider: "n8n", account, batch_id: "b1" },
        records: [
          upsert("pipeline", "sales", {
            kind: "deal",
            name: "Sales",
            stages: [{ external_id: "new", name: "New", position: 1, outcome: "open" }],
          }),
          upsert("organization", company.toLowerCase(), { name: company }),
          upsert("deal", deal, { title: deal, pipeline: "sales", stage: "new", status: "open" }, [
            { role: "organization", type: "organization", external_id: company.toLowerCase() },
          ]),
        ],
      },
      { account },
    )
    const record = await store.records.get({
      provider: "n8n",
      account,
      type: "organization",
      externalId: company.toLowerCase(),
    })
    return String(record?.entity)
  }
  const names = async () => (await store.knowledge.organizations()).map((one) => one.name)
  return { store, send, names }
}

it("shows what deleting an organization takes, then deletes it and keeps its deal", async () => {
  const { store, send, names } = await fixture()
  const acme = await send("deals", "Acme Test", "Bikes")

  const preview = await store.knowledge.eraseOrganization(acme, "owner", { apply: false })
  expect(preview).toMatchObject({ organization: acme, name: "Acme Test", erased: false })
  expect(Object.keys(preview.detached)).toEqual(expect.arrayContaining(["deals.organization_id"]))
  expect(await names()).toContain("Acme Test")

  expect(await store.knowledge.eraseOrganization(acme, "owner", { apply: true })).toMatchObject({ erased: true })
  expect(await names()).not.toContain("Acme Test")
  const deal = await store.records.get({ provider: "n8n", account: "deals", type: "deal", externalId: "Bikes" })
  expect(deal?.entity).toMatch(/^deal:/)
  await expect(store.knowledge.eraseOrganization(acme, "owner", { apply: true })).rejects.toMatchObject({
    code: "not_found",
  })
})

it("deletes an organization only as the owner, and never one of the owner's own", async () => {
  const { store, send } = await fixture()
  const acme = await send("deals", "Acme Test", "Bikes")
  await expect(
    store.knowledge.eraseOrganization(acme, { bot: "agent", reason: "test" }, { apply: true }),
  ).rejects.toMatchObject({ code: "permission_error" })
  await store.knowledge.setOwnOrganization(acme, true)
  await expect(store.knowledge.eraseOrganization(acme, "owner", { apply: false })).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("purging an import takes the organizations only its records made, and keeps one another source also names", async () => {
  const { store, send, names } = await fixture()
  await send("test", "Only Test", "Deal A")
  await send("test", "Shared Co", "Deal B")
  await send("site", "Shared Co", "Deal C")

  await store.accounts.purge({ provider: "n8n", account: "test" })

  expect(await names()).not.toContain("Only Test")
  expect(await names()).toContain("Shared Co")
})
