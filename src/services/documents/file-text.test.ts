import { describe, expect, it } from "vitest"
import { fileText, readableFile } from "./file-text.js"

describe("fileText", () => {
  it("reads a text file and says why a file has no text", async () => {
    const plain = { name: "notes.txt", mime: "text/plain" }
    expect(await fileText(new TextEncoder().encode("quarterly budget"), plain, "box")).toContain("quarterly budget")
    await expect(
      fileText(Uint8Array.of(1, 2, 3), { name: "broken.pdf", mime: "application/pdf" }, "box"),
    ).rejects.toMatchObject({ code: "validation_error" })
  })
  it("knows the readable types by type or by name", () => {
    expect(readableFile({ name: "a.bin", mime: "application/pdf" })).toBe(true)
    expect(readableFile({ name: "README.md", mime: "application/octet-stream" })).toBe(true)
    expect(readableFile({ name: "photo.jpg", mime: "image/jpeg" })).toBe(false)
  })
})
