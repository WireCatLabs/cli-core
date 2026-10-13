import { describe, expect, it } from "vitest"
import { googleDocumentLinks } from "./google-documents.js"

const ID = "1SyntheticFileId_abc-XYZ0123456789"

describe("googleDocumentLinks", () => {
  it.each([
    `https://docs.google.com/document/d/${ID}/edit?usp=sharing`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    `https://docs.google.com/presentation/d/${ID}/view`,
    `https://docs.google.com/forms/d/${ID}/viewform`,
    `https://docs.google.com/forms/d/e/${ID}/viewform`,
    `https://docs.google.com/document/u/1/d/${ID}/edit`,
    `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
    `https://drive.google.com/u/0/file/d/${ID}/view`,
    `https://drive.google.com/open?id=${ID}`,
    `http://drive.google.com/uc?id=${ID}&export=download`,
  ])("takes the file id from %s", (url) => {
    expect(googleDocumentLinks(`see ${url} please`)).toEqual([{ url, documentId: ID }])
  })

  it("gives no id for a Drive page, a folder or a shortened link", () => {
    expect(
      googleDocumentLinks(
        "https://drive.google.com/drive/my-drive https://drive.google.com/drive/folders/1FolderIdFolderId https://forms.gle/AbCdEf",
      ).map(({ documentId }) => documentId),
    ).toEqual([null, null, null])
  })

  it("ignores other URLs and a bare id", () => {
    expect(googleDocumentLinks(`https://example.com/d/${ID} https://www.google.com/search?q=x ${ID}`)).toEqual([])
  })

  it("finds two links in one text and leaves the punctuation after them", () => {
    const first = `https://docs.google.com/document/d/${ID}/edit`
    const second = "https://docs.google.com/spreadsheets/d/2OtherSyntheticId_0000/edit"
    expect(googleDocumentLinks(`(${first}), and ${second}.`)).toEqual([
      { url: first, documentId: ID },
      { url: second, documentId: "2OtherSyntheticId_0000" },
    ])
  })
})
