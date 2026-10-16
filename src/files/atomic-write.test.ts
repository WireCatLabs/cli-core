import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { writeFileAtomic } from "./index.js"

const folder = () => mkdtemp(join(tmpdir(), "core-test-atomic-"))

it("replaces the file whole, owner-only by default, and leaves no temporary file", async () => {
  const dir = await folder()
  const path = join(dir, "state.json")
  await writeFile(path, "old")
  await writeFileAtomic(path, '{"new":true}')
  expect(await readFile(path, "utf8")).toBe('{"new":true}')
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readdir(dir)).toEqual(["state.json"])
})

it("refuses to replace an existing file when overwrite is off", async () => {
  const dir = await folder()
  const path = join(dir, "export.txt")
  await writeFile(path, "kept")
  await expect(writeFileAtomic(path, "new", { overwrite: false })).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(path, "utf8")).toBe("kept")
  await writeFileAtomic(join(dir, "fresh.txt"), new TextEncoder().encode("bytes"), { overwrite: false })
  expect(await readFile(join(dir, "fresh.txt"), "utf8")).toBe("bytes")
  expect((await readdir(dir)).sort()).toEqual(["export.txt", "fresh.txt"])
})

it("publishes nothing when the last check before publishing refuses or the write is cancelled", async () => {
  const dir = await folder()
  const path = join(dir, "checkpoint.json")
  await writeFile(path, "before")
  const refused = writeFileAtomic(path, "after", {
    beforePublish: () => {
      throw new Error("lease changed")
    },
  })
  await expect(refused).rejects.toThrow("lease changed")
  const controller = new AbortController()
  controller.abort()
  await expect(writeFileAtomic(path, "after", { signal: controller.signal })).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("before")
  expect(await readdir(dir)).toEqual(["checkpoint.json"])
})
