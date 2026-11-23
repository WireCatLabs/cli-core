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
  const path = join(mkdtempSync(join(tmpdir(), "person-erase-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  const send = async (account: string, email: string, title: string) => {
    await ingest(
      store,
      {
        schema_version: 1,
        source: { provider: "n8n", account, batch_id: "b1" },
        records: [
          upsert("pipeline", "web", {
            kind: "lead",
            name: "Web",
            stages: [{ external_id: "new", name: "New", position: 1, outcome: "open" }],
          }),
          upsert("person", email, { name: title, email, phone: `+346${String(email.length).padStart(8, "0")}` }),
          upsert("lead", email, { title, pipeline: "web", stage: "new" }, [
            { role: "person", type: "person", external_id: email },
          ]),
        ],
      },
      { account },
    )
    const record = await store.records.get({ provider: "n8n", account, type: "person", externalId: email })
    return String(record?.entity)
  }
  const names = async () => (await store.people.list({ kind: "all", limit: 100 })).items.map((one) => one.displayName)
  return { store, send, names }
}

it("shows what deleting a person takes without changing anything, then deletes them and keeps the lead", async () => {
  const { store, send, names } = await fixture()
  const anna = await send("site", "anna@example.org", "Anna Test")
  expect(await names()).toContain("Anna Test")

  const preview = await store.people.erase(anna, "owner", { apply: false })
  expect(preview).toMatchObject({ person: anna, erased: false, kept: [] })
  expect(preview.identities.sort()).toEqual([
    "email:anna@example.org",
    "n8n:site/contact/anna@example.org",
    "phone:+34600000016",
  ])
  expect(await names()).toContain("Anna Test")

  expect(await store.people.erase(anna, "owner", { apply: true })).toMatchObject({ person: anna, erased: true })
  expect(await names()).not.toContain("Anna Test")
  const lead = await store.records.get({
    provider: "n8n",
    account: "site",
    type: "lead",
    externalId: "anna@example.org",
  })
  expect(lead?.entity).toMatch(/^lead:/)
  expect(
    (await store.records.get({ provider: "n8n", account: "site", type: "person", externalId: "anna@example.org" }))
      ?.entity,
  ).toBeNull()
  await expect(store.people.erase(anna, "owner", { apply: true })).rejects.toMatchObject({ code: "not_found" })
})

it("deletes a person only as the owner, and never the owner's own person", async () => {
  const { store, send } = await fixture()
  const anna = await send("site", "anna@example.org", "Anna Test")
  await expect(store.people.erase(anna, { bot: "agent", reason: "test" }, { apply: true })).rejects.toMatchObject({
    code: "permission_error",
  })
  const owner = await store.people.owner()
  if (owner)
    await expect(store.people.erase(owner.uid, "owner", { apply: false })).rejects.toMatchObject({
      code: "validation_error",
    })
})

it("purging an import takes the people only its records made, and keeps one another source also knows", async () => {
  const { store, send, names } = await fixture()
  await send("test", "anna@example.org", "Anna Test")
  await send("test", "boris@example.org", "Boris Both")
  await send("site", "boris@example.org", "Boris Both")

  await store.accounts.purge({ provider: "n8n", account: "test" })

  expect(await names()).not.toContain("Anna Test")
  expect(await names()).toContain("Boris Both")
})
