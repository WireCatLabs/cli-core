import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { save } from "./download-command.js"

it.each([undefined, "photo.custom"])(
  "uses lazy response MIME for fallback names, preserving supplied name %s",
  async (name) => {
    const directory = mkdtempSync(join(tmpdir(), "download-mime-"))
    let mime = ""
    let closed = false
    const file = {
      kind: "photo",
      ...(name === undefined ? {} : { name }),
      get mime() {
        return mime
      },
      bytes: async function* () {
        try {
          mime = "image/webp"
          yield new Uint8Array([1, 2, 3])
        } finally {
          closed = true
        }
      },
    }
    const expected = name ?? "synthetic-1.webp"
    expect(await save(file, directory, "synthetic-1")).toEqual({
      kind: "photo",
      path: join(directory, expected),
      bytes: 3,
    })
    expect(closed).toBe(true)
    expect([...readFileSync(join(directory, expected))]).toEqual([1, 2, 3])
    expect(readdirSync(directory)).toEqual([expected])
  },
)

it("keeps a late-MIME failure atomic and closes the byte iterator", async () => {
  const directory = mkdtempSync(join(tmpdir(), "download-mime-"))
  let closed = false
  let mime = ""
  const file = {
    kind: "photo",
    get mime() {
      return mime
    },
    bytes: async function* () {
      try {
        mime = "image/webp"
        yield new Uint8Array([1])
        throw new Error("interrupted")
      } finally {
        closed = true
      }
    },
  }
  await expect(save(file, directory, "synthetic-1")).rejects.toThrow("interrupted")
  expect(closed).toBe(true)
  expect(readdirSync(directory)).toEqual([])
})

it("keeps a file named after its message inside the folder, whatever the message id holds", async () => {
  const parent = mkdtempSync(join(tmpdir(), "download-name-"))
  const directory = join(parent, "into")
  mkdirSync(directory)
  const file = {
    kind: "file",
    bytes: async function* () {
      yield new Uint8Array([1])
    },
  }

  const saved = await save(file, directory, "../escaped")

  expect(saved.path).toBe(join(directory, "escaped"))
  expect(readdirSync(parent)).toEqual(["into"])
})
