import { describe, expect, it } from "vitest"
import { crmFileId, LINK_REMOVED, parseCrmFileId, withoutFileLinks } from "./files.js"
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

describe("a file field's custom value", () => {
  it("keeps the file's name and id but never its tokened link", () => {
    const link = "https://portal.example/download/?auth=abc&fileId=9"
    const values = crmValuesOf({ UF_CONTRACT: { id: 9, name: "contract.pdf", downloadUrl: link } }, [])
    expect(values.UF_CONTRACT?.value).toEqual({ id: 9, name: "contract.pdf", downloadUrl: LINK_REMOVED })
  })
})
