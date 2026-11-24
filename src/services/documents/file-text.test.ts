import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { officeFixture } from "../../testing/office-files.js"
import { fileText, readableFile } from "./file-text.js"

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
const ODT = "application/vnd.oasis.opendocument.text"

describe("fileText", () => {
  it("reads a text file and says why a file has no text", async () => {
    const plain = { name: "notes.txt", mime: "text/plain" }
    expect(await fileText(new TextEncoder().encode("quarterly budget"), plain, "box")).toContain("quarterly budget")
    await expect(
      fileText(Uint8Array.of(1, 2, 3), { name: "broken.pdf", mime: "application/pdf" }, "box"),
    ).rejects.toMatchObject({ code: "validation_error" })
  })
  it("reads the slides, OpenDocument text and old Word files a sync now takes in", async () => {
    expect(await fileText(officeFixture("pptx"), { name: "deck.pptx", mime: PPTX }, "box")).toContain(
      "First slideneedle",
    )
    expect(await fileText(officeFixture("odt"), { name: "letter.odt", mime: ODT }, "box")).toContain("readerneedle")
    const doc = new Uint8Array(readFileSync(new URL("../../testing/fixtures/legacy.doc", import.meta.url)))
    expect(await fileText(doc, { name: "legacy.doc", mime: "application/msword" }, "box")).toContain(
      "The heron count rose to 42",
    )
  })
  it("knows the readable types by type or by name, and keeps images out", () => {
    expect(readableFile({ name: "a.bin", mime: "application/pdf" })).toBe(true)
    expect(readableFile({ name: "README.md", mime: "application/octet-stream" })).toBe(true)
    for (const mime of [
      "application/msword",
      "application/rtf",
      "text/html",
      PPTX,
      ODT,
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/epub+zip",
    ])
      expect(readableFile({ name: "file", mime })).toBe(true)
    for (const name of ["a.doc", "a.rtf", "a.htm", "a.html", "a.odt", "a.ods", "a.odp", "a.pptx", "a.epub"])
      expect(readableFile({ name, mime: "application/octet-stream" })).toBe(true)
    expect(readableFile({ name: "photo.jpg", mime: "image/jpeg" })).toBe(false)
    expect(readableFile({ name: "scan.tiff", mime: "image/tiff" })).toBe(false)
  })
})
