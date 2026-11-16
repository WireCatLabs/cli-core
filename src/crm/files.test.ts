import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openCache } from "../store/open.js"
import { crmIdentityId } from "../store/sqlite/crm.js"
import { crmSettingKey, saveCrmSetting } from "../store/sqlite/crm-settings.js"
import { openStore } from "../store/store.js"
import { crmFileId, LINK_REMOVED, parseCrmFileId, withoutFileLinks } from "./files.js"
import { syncCrm } from "./index.js"
import { exampleDeal, fakeCrmSource } from "./testing/index.js"
import { crmValuesOf } from "./values.js"

describe("CRM file ids", () => {
  it("name the owner and the source, and keep a provider id with colons whole", () => {
    const id = crmFileId({ kind: "deal", id: "12" }, "activity", "disk:345")
    expect(id).toBe("deal:12:activity:disk:345")
    expect(parseCrmFileId(id)).toEqual({
      owner: { kind: "deal", id: "12" },
      source: "activity",
      providerId: "disk:345",
    })
  })

  it.each(["deal:12", "task:1:record:2", "deal:1:attachment:2", "deal:../x:record:2", "deal:12:record:"])(
    "refuses %s",
    (id) => {
      expect(() => parseCrmFileId(id)).toThrow(expect.objectContaining({ details: { reason: "ref.malformed" } }))
    },
  )
})

describe("withoutFileLinks", () => {
  it("removes every tokened link the CRMs answer, and keeps the rest", () => {
    const body = {
      result: {
        item: {
          title: "Example deal",
          ufCrmContract: [{ id: 9, urlMachine: "https://portal.example/rest/download?id=9" }],
          documents: [{ id: 1, pdfUrlMachine: "x", downloadUrlMachine: "y", imageUrlMachine: "z" }],
          disk: { DOWNLOAD_URL: "https://portal.example/disk/9" },
          notes: "see https://portal.example/a?auth=abc and more",
          site: "https://example.com/page",
        },
      },
      _embedded: { files: [{ file_uuid: "u1", _links: { download: { href: "https://drive.example/u1" } } }] },
      _links: { self: { href: "https://example.amocrm.ru/api/v4/leads/1/files" } },
    }
    expect(withoutFileLinks(body)).toEqual({
      result: {
        item: {
          title: "Example deal",
          ufCrmContract: [{ id: 9, urlMachine: LINK_REMOVED }],
          documents: [
            { id: 1, pdfUrlMachine: LINK_REMOVED, downloadUrlMachine: LINK_REMOVED, imageUrlMachine: LINK_REMOVED },
          ],
          disk: { DOWNLOAD_URL: LINK_REMOVED },
          notes: LINK_REMOVED,
          site: "https://example.com/page",
        },
      },
      _embedded: { files: [{ file_uuid: "u1", _links: { download: LINK_REMOVED } }] },
      _links: { self: { href: "https://example.amocrm.ru/api/v4/leads/1/files" } },
    })
  })
})

describe("withoutFileLinks over Bitrix24's shapes (bitrix24-cli's filter)", () => {
  const TOKEN = "FAKEFILETOKEN0123456789"
  const HOST = "https://example.bitrix24.test"

  it.each([
    ["a relative show_file.php link", `/bitrix/components/bitrix/crm.lead.show/show_file.php?auth=${TOKEN}&fileId=1`],
    ["a REST link with token", `${HOST}/rest/download.json?token=${TOKEN}`],
    ["a webhook", `${HOST}/rest/7/${TOKEN}/disk.file.get?id=1`],
    ["a link copied out of HTML", `see ${HOST}/rest/download.json?x=1&amp;auth=${TOKEN}`],
    ["an access_token", `${HOST}/rest/x?access_token=${TOKEN}`],
    ["an api_token anywhere", `https://files.example/f/1?api_token=${TOKEN}`],
    ["a signed storage link", `https://bucket.example/f.pdf?X-Amz-Credential=a&X-Amz-Signature=${TOKEN}`],
  ])("removes %s", (_why, link) => {
    expect(withoutFileLinks({ text: link })).toEqual({ text: LINK_REMOVED })
  })

  it("removes every download key, folded, and keeps a typed site, a link field and an empty key", () => {
    expect(
      withoutFileLinks({
        a: { printUrlMachine: "x", someOtherMachine: "y", CALL_RECORD_URL: "z", call_record_url: "z" },
        b: { publicUrl: `${HOST}/~bat5R`, fileUrl: "f", archiveLink: "l", download_url: "d" },
        empty: { DOWNLOAD_URL: null, downloadUrl: "" },
        site: "https://shop.example/?token=promo",
        link: { url: "https://shop.example/catalog", title: "Catalog" },
      }),
    ).toEqual({
      a: {
        printUrlMachine: LINK_REMOVED,
        someOtherMachine: LINK_REMOVED,
        CALL_RECORD_URL: LINK_REMOVED,
        call_record_url: LINK_REMOVED,
      },
      b: { publicUrl: LINK_REMOVED, fileUrl: LINK_REMOVED, archiveLink: LINK_REMOVED, download_url: LINK_REMOVED },
      empty: { DOWNLOAD_URL: null, downloadUrl: "" },
      site: "https://shop.example/?token=promo",
      link: { url: "https://shop.example/catalog", title: "Catalog" },
    })
  })
})

describe("a file field's custom value", () => {
  it("keeps the file's name and id but never its tokened link", () => {
    const link = "https://portal.example/download/?auth=abc&fileId=9"
    const values = crmValuesOf({ UF_CONTRACT: { id: 9, name: "contract.pdf", downloadUrl: link } }, [])
    expect(values.UF_CONTRACT?.value).toEqual({ id: 9, name: "contract.pdf", downloadUrl: LINK_REMOVED })
  })
})

describe("a file's text follows its deal (SEC-3)", () => {
  it("is found by the deal's current assignee, not the one at download", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "crm-file-viewer-")), "store.db")
    const store = await openStore({ path })
    try {
      const portal = { provider: "example-crm", account: "portal" }
      const database = await openCache(path)
      saveCrmSetting(database, crmSettingKey(portal, "scope"), "all", 1)
      database.close()
      const source = fakeCrmSource({ self: "7" })
      source.put("deal", exampleDeal("d1", { assignee: "7", updatedAt: 1_000 }))
      await syncCrm(source, store, portal)
      const anna = crmIdentityId(portal, "7", "user")
      const boris = crmIdentityId(portal, "8", "user")
      const saved = {
        externalId: "deal:d1:record:f1",
        ownerKind: "deal",
        ownerId: "d1",
        ownerAssignee: anna,
        source: "record",
        name: "contract.txt",
        mime: null,
        size: 10,
        externalCreatedAt: null,
        localPath: null,
        contentSha256: null,
        text: "example kitchen contract",
        extraction: "extracted",
        extractionError: null,
        downloadedBy: "7",
        downloadedAt: 1,
      }
      await store.crmFiles.save(portal, saved)
      await store.crmFiles.save(portal, {
        ...saved,
        externalId: "person:p1:record:f2",
        ownerKind: "person",
        ownerId: "p1",
        name: "card.txt",
      })
      const names = async (assignee: string) =>
        (await store.crmFiles.find({ words: ["kitchen"], viewers: [{ account: portal, assignee }] })).items
          .map((hit) => hit.file.name)
          .sort()
      expect(await names(anna)).toEqual(["card.txt", "contract.txt"])
      source.put("deal", exampleDeal("d1", { assignee: "8", updatedAt: 2_000 }))
      await syncCrm(source, store, portal)
      expect(await names(anna)).toEqual(["card.txt"])
      expect(await names(boris)).toEqual(["contract.txt"])
    } finally {
      await store.close()
    }
  })
})
