import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "portal" }

it("gives a version 67 file a place for downloaded CRM files, with their words indexed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-68-")), "wirecat.db")
  const store = await openStore({ path })
  await store.crm.savePipelines(PORTAL, "deal", [])
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 68)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crm_files'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    await upgraded.crmFiles.save(PORTAL, {
      externalId: "lead:4:record:9",
      ownerKind: "lead",
      ownerId: "4",
      ownerAssignee: "portal/user/7",
      source: "record",
      name: "Price list.docx",
      mime: null,
      size: 10,
      externalCreatedAt: null,
      localPath: null,
      contentSha256: null,
      text: "Example price list",
      extraction: "extracted",
      extractionError: null,
      downloadedBy: "7",
      downloadedAt: 1,
    })
    expect((await upgraded.crmFiles.find({ words: ["price"] })).items).toHaveLength(1)
  } finally {
    await upgraded.close()
  }
})
