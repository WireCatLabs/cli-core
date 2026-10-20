import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { readBoundedUtf8File } from "./bounded-utf8.js"

it("reads exact-budget UTF-8 and refuses oversize and invalid encodings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bounded-utf8-")),
    path = join(directory, "input.json")
  const text = '{"text":"例"}'
  await writeFile(path, text)
  expect(await readBoundedUtf8File(path, { maxBytes: Buffer.byteLength(text) })).toBe(text)
  await expect(readBoundedUtf8File(path, { maxBytes: Buffer.byteLength(text) - 1 })).rejects.toMatchObject({
    code: "validation_error",
  })
  await writeFile(path, Buffer.from([0xff, 0xfe]))
  await expect(readBoundedUtf8File(path, { maxBytes: 2 })).rejects.toMatchObject({
    code: "validation_error",
    message: expect.stringContaining("UTF-8"),
  })
})

it("validates the byte budget before opening an input", async () => {
  for (const maxBytes of [0, -1, 0.5, Number.NaN, 16777217])
    await expect(readBoundedUtf8File("missing-example.json", { maxBytes })).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("maxBytes"),
    })
})
