import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
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

it("writes into a folder reached through a symlink, and refuses a second write cleanly when overwrite is off", async () => {
  const dir = await folder()
  const real = join(dir, "real")
  await mkdir(real)
  await symlink(real, join(dir, "linked"), "junction")
  const path = join(dir, "linked", "checkpoint.json")
  await writeFileAtomic(path, "first", { overwrite: false })
  expect(await readFile(join(real, "checkpoint.json"), "utf8")).toBe("first")
  await expect(writeFileAtomic(path, "second", { overwrite: false })).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(path, "utf8")).toBe("first")
  await writeFileAtomic(path, "replaced")
  expect(await readFile(path, "utf8")).toBe("replaced")
  expect(await readdir(real)).toEqual(["checkpoint.json"])
})

it("writes nothing when the folder cannot be used", async () => {
  const dir = await folder()
  await symlink(join(dir, "missing"), join(dir, "dangling"), "junction")
  await writeFile(join(dir, "plain"), "a file, not a folder")
  await expect(writeFileAtomic(join(dir, "dangling", "state.json"), "x")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(writeFileAtomic(join(dir, "plain", "state.json"), "x")).rejects.toThrow()
  expect((await readdir(dir)).sort()).toEqual(["dangling", "plain"])
})
