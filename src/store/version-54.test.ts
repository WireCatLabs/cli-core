import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "portal" }
const SOURCE = {
  code: "UF_SOURCE",
  label: "Source",
  type: "enumeration",
  multiple: false,
  filterable: true,
  options: [{ id: "1", label: "Website" }],
}

it("gives a version 53 file a place for a CRM account's fields, kept apart per kind and brought back when listed again", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-54-")), "wirecat.db")
  const store = await openStore({ path })
  await store.crm.savePipelines(PORTAL, "deal", [])
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 54)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crm_fields'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.crm.saveFields(PORTAL, "deal", [SOURCE])).toEqual({ saved: 1, skipped: [] })
    await upgraded.crm.saveFields(PORTAL, "lead", [{ ...SOURCE, label: "Lead source", options: undefined }])
    await upgraded.crm.saveFields(PORTAL, "deal", [])
    expect(await upgraded.crm.fields(PORTAL, "deal")).toEqual([])
    await upgraded.crm.saveFields(PORTAL, "deal", [SOURCE])
    expect(await upgraded.crm.fields(PORTAL, "deal")).toEqual([SOURCE])
    expect(await upgraded.crm.fields(PORTAL, "lead")).toEqual([
      { code: "UF_SOURCE", label: "Lead source", type: "enumeration", multiple: false, filterable: true },
    ])
  } finally {
    await upgraded.close()
  }
})
