import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CrmFileRow } from "./sqlite/crm-files.js"
import { type MessageStore, openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "portal" }
const OTHER = { provider: "example-crm", account: "other" }
const ANNA = "portal/user/7"
const BORIS = "portal/user/8"
const FOLDER = "/state/crm/files/example-crm-portal/"

const fileOf = (id: string, fields: Partial<CrmFileRow> = {}): CrmFileRow => ({
  externalId: `deal:${id}:record:${id}`,
  ownerKind: "deal",
  ownerId: id,
  ownerAssignee: ANNA,
  source: "record",
  name: `contract-${id}.pdf`,
  mime: "application/pdf",
  size: 100,
  externalCreatedAt: null,
  localPath: `${FOLDER}deal-${id}/contract-${id}.pdf`,
  contentSha256: null,
  text: `Supply contract number ${id} for the example kitchen`,
  extraction: "extracted",
  extractionError: null,
  downloadedBy: "7",
  downloadedAt: 1_000 + Number(id),
  ...fields,
})

let store: MessageStore
beforeEach(async () => {
  store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-files-")), "wirecat.db") })
})
afterEach(async () => {
  await store.close()
})

describe("crm_files", () => {
  it("keeps one row per downloaded file, a repeat download replacing it, and lists a record's files", async () => {
    await store.crmFiles.save(PORTAL, fileOf("1"))
    await store.crmFiles.save(PORTAL, fileOf("1", { name: "contract-1-signed.pdf", downloadedAt: 5_000 }))
    await store.crmFiles.save(PORTAL, fileOf("2"))
    expect(await store.crmFiles.get(PORTAL, "deal:1:record:1")).toMatchObject({
      name: "contract-1-signed.pdf",
      text: "Supply contract number 1 for the example kitchen",
    })
    expect((await store.crmFiles.ofOwner(PORTAL, "deal", "1")).map((one) => one.name)).toEqual([
      "contract-1-signed.pdf",
    ])
    expect(await store.crmFiles.get(OTHER, "deal:1:record:1")).toBeUndefined()
  })

  it("finds the text by its words, a limited viewer only its own records' files (NEED-2707 A)", async () => {
    // A contact's file: the assignee at download decides. A deal's follows the copy (src/crm/files.test.ts).
    const contact = (id: string, fields: Partial<CrmFileRow> = {}) =>
      fileOf(id, { externalId: `person:${id}:record:${id}`, ownerKind: "person", ...fields })
    await store.crmFiles.save(PORTAL, contact("1"))
    await store.crmFiles.save(PORTAL, contact("2", { ownerAssignee: BORIS }))
    await store.crmFiles.save(PORTAL, fileOf("9"))
    await store.crmFiles.save(OTHER, fileOf("3", { ownerAssignee: BORIS }))
    const names = async (viewers?: { account: typeof PORTAL; assignee: string | null }[]) =>
      (await store.crmFiles.find({ words: ["kitchen"], ...(viewers ? { viewers } : {}) })).items
        .map((hit) => `${hit.account.account}:${hit.file.ownerId}`)
        .sort()
    expect(await names()).toEqual(["other:3", "portal:1", "portal:2", "portal:9"])
    expect(await names([{ account: PORTAL, assignee: ANNA }])).toEqual(["other:3", "portal:1"])
    expect(await names([{ account: PORTAL, assignee: BORIS }])).toEqual(["other:3", "portal:2"])
    expect(await names([{ account: PORTAL, assignee: null }])).toEqual(["other:3"])
    const [hit] = (await store.crmFiles.find({ words: ["kitch"], accounts: [PORTAL], limit: 1 })).items
    expect(hit?.excerpt).toContain("example kitchen")
    expect((await store.crmFiles.find({ words: ["kitch"], exact: true })).items).toEqual([])
    expect((await store.crmFiles.find({ words: ['"OR'] })).items).toEqual([])
  })

  it("counts and drops only files under the account's folder that have text; the text stays searchable", async () => {
    await store.crmFiles.save(PORTAL, fileOf("1"))
    await store.crmFiles.save(PORTAL, fileOf("2", { text: null, extraction: "needs-agent" }))
    await store.crmFiles.save(PORTAL, fileOf("3", { localPath: "/home/owner/Downloads/contract-3.pdf" }))
    await store.crmFiles.save(PORTAL, fileOf("4"))
    expect(await store.crmFiles.storedBytes(PORTAL, FOLDER)).toBe(300)
    expect((await store.crmFiles.droppable(PORTAL, FOLDER)).map((one) => one.ownerId)).toEqual(["1", "4"])
    await store.crmFiles.forgetFile(PORTAL, "deal:1:record:1")
    expect(await store.crmFiles.storedBytes(PORTAL, FOLDER)).toBe(200)
    expect((await store.crmFiles.get(PORTAL, "deal:1:record:1"))?.localPath).toBeNull()
    expect((await store.crmFiles.find({ words: ["number", "1"] })).items.map((hit) => hit.file.ownerId)).toContain("1")
  })

  it("matches the folder with its separator, so a sibling folder's files are neither counted nor dropped", async () => {
    await store.crmFiles.save(PORTAL, fileOf("1"))
    await store.crmFiles.save(PORTAL, fileOf("2", { localPath: "/state/crm/files/example-crm-portal2/deal-2/b.pdf" }))
    const folder = FOLDER.slice(0, -1)
    expect(await store.crmFiles.storedBytes(PORTAL, folder)).toBe(100)
    expect((await store.crmFiles.droppable(PORTAL, folder)).map((one) => one.ownerId)).toEqual(["1"])
    expect(await store.crmFiles.savedPaths(PORTAL)).toEqual([
      `${FOLDER}deal-1/contract-1.pdf`,
      "/state/crm/files/example-crm-portal2/deal-2/b.pdf",
    ])
  })

  it("goes with its account's purge, words and all", async () => {
    await store.crmFiles.save(PORTAL, fileOf("1"))
    await store.accounts.purge(PORTAL)
    expect((await store.crmFiles.find({ words: ["kitchen"] })).items).toEqual([])
  })
})
