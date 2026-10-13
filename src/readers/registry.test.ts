import { afterEach, describe, expect, it } from "vitest"
import { extractText, importEngine } from "../attachments/extract.js"
import { registeredReaders, registerReader } from "./registry.js"
import type { Reader } from "./types.js"

const hint = (name: string) => ({ kind: "file", name, mime: null, path: `/saved/${name}` })
const custom = (id: string, extension: string, text: string): Reader => ({
  id,
  version: "v1",
  accepts: (candidate) => candidate.name?.endsWith(extension) ?? false,
  read: async () => ({ status: "extracted", text, extractor: `${id}:v1` }),
})
const undo: (() => void)[] = []
const add = (reader: Reader, options?: { before?: string }) => {
  undo.push(registerReader(reader, options))
}

afterEach(() => {
  for (const remove of undo.splice(0).reverse()) remove()
})

describe("the reader registry", () => {
  it("keeps the built-ins in the order of the old if chain", () => {
    expect(registeredReaders().map((reader) => reader.id)).toEqual([
      "office",
      "pdf",
      "docx",
      "doc",
      "rtf",
      "html",
      "sheets",
      "plain",
      "image",
    ])
  })

  it("puts a reader registered before another one ahead of it", async () => {
    add(custom("loud", ".txt", "custom"), { before: "plain" })
    const result = await extractText(new TextEncoder().encode("hello"), hint("a.txt"), importEngine)
    expect(result).toMatchObject({ status: "extracted", text: "custom", extractor: "loud:v1" })
    expect(() => registerReader(custom("x", ".x", ""), { before: "nope" })).toThrow(/no reader named nope/)
  })

  it("reads a new extension through a registered reader and replaces a reader with the same id", async () => {
    const bytes = new TextEncoder().encode("data")
    expect(await extractText(bytes, hint("a.xyz"), importEngine)).toEqual({ status: "unsupported" })
    add(custom("xyz", ".xyz", "one"))
    add(custom("xyz", ".xyz", "two"))
    expect(registeredReaders().filter((reader) => reader.id === "xyz")).toHaveLength(1)
    expect(await extractText(bytes, hint("a.xyz"), importEngine)).toMatchObject({ status: "extracted", text: "two" })
  })
})
