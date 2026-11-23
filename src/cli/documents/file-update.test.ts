import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { Expect, FileTarget } from "../../documents/file-mirror-model.js"
import { guardedFileWrite } from "../../services/files/guarded-write.js"
import { fileVersions } from "../../services/files/versions.js"
import type { Body } from "../envelope.js"
import { addFileUpdateCommand } from "./file-update.js"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const OLD = "# Notes\nthe first draft\n"
const NEW = "# Notes\nthe second draft\n"

/** A provider in memory: no conditional upload, so `upload` checks `expect` itself, as a real target does. */
const fakeTarget = () => {
  const files = new Map<string, string>([["/notes.md", OLD]])
  const uploads: { path: string; expect: Expect }[] = []
  let beforeUpload: (() => void) | undefined
  const describeFile = (path: string) => {
    const text = files.get(path) ?? ""
    return { path, id: `id-${path}`, size: text.length, sha256: sha256(text), modifiedAt: "2026-11-23T00:00:00.000Z" }
  }
  const target: FileTarget = {
    identity: async () => "fake",
    list: async () => undefined,
    exists: async (path) => files.has(path),
    download: async (path, into) => writeFileSync(into, files.get(path) ?? "", { flag: "wx" }),
    upload: async (path, from, expect) => {
      beforeUpload?.()
      const here = files.get(path)
      const ok = "absent" in expect ? here === undefined : here !== undefined && sha256(here) === expect.sha256
      if (!ok) throw new CliError("conflict", "the remote file is not as expected")
      uploads.push({ path, expect })
      files.set(path, await readFile(from, "utf8"))
      return describeFile(path)
    },
    trash: async () => {},
    ensureFolder: async () => {},
  }
  return {
    target,
    files,
    uploads,
    whenUploading: (change: () => void) => {
      beforeUpload = change
    },
  }
}

const harness = (stdin?: string) => {
  const fake = fakeTarget()
  const versions = fileVersions(join(mkdtempSync(join(tmpdir(), "file-update-")), "files.versions"))
  const asked: (readonly string[])[] = []
  const answers: Body[] = []
  const files = new Command("files").exitOverride()
  const update = addFileUpdateCommand(files, {
    words: { app: "disk", remote: "disk", provider: "Disk", source: "disk" },
    output: (body) => answers.push(body),
    path: (input) => input,
    reread: (input) => `disk personal files show ${input}`,
    stdin: () => (stdin === undefined ? undefined : Object.assign(Readable.from([stdin]), { isTTY: false })),
    write: async (extra, act) => {
      asked.push(extra)
      return { operation_id: "op-1", ...(await act({ target: fake.target, versions })) }
    },
  })
  const run = (...argv: string[]) => files.parseAsync(["update", ...argv], { from: "user" })
  const item = () => (answers.at(-1) as { item: Record<string, unknown> }).item
  return { ...fake, versions, asked, run, item, update }
}

describe("files update", () => {
  it("replaces the file at the hash it was read at, asks the delete key, and keeps what it replaced", async () => {
    const disk = harness()
    await disk.run("/notes.md", "--text", NEW, "--expected-fingerprint", sha256(OLD))
    expect(disk.files.get("/notes.md")).toBe(NEW)
    expect(disk.asked).toEqual([["files.delete"]])
    const item = disk.item() as { sha256: string; replaced: { sha256: string; kept_at: string } }
    expect(item).toMatchObject({ operation_id: "op-1", path: "/notes.md", sha256: sha256(NEW) })
    expect(item.replaced.sha256).toBe(sha256(OLD))
    expect(readFileSync(item.replaced.kept_at, "utf8")).toBe(OLD)
    expect(disk.versions.list("/notes.md")).toMatchObject([
      { event: "changed", old: sha256(OLD), new: sha256(NEW), from: "remote", available: true },
    ])
  })

  it("a wrong hash is a conflict that says how to read the file again, and nothing is uploaded", async () => {
    const disk = harness()
    const stale = disk.run("/notes.md", "--text", NEW, "--expected-fingerprint", sha256("an older read"))
    await expect(stale).rejects.toMatchObject({ code: "conflict", details: { reason: "mirror.remote-changed" } })
    await expect(stale).rejects.toThrow("disk personal files show /notes.md")
    expect(disk.uploads).toEqual([])
    expect(disk.files.get("/notes.md")).toBe(OLD)
  })

  it("a change after the file was kept is caught by the target's check, and nothing is uploaded", async () => {
    const disk = harness()
    disk.whenUploading(() => disk.files.set("/notes.md", "another device's edit"))
    const raced = disk.run("/notes.md", "--text", NEW, "--expected-fingerprint", sha256(OLD))
    await expect(raced).rejects.toMatchObject({ code: "conflict", details: { reason: "mirror.remote-changed" } })
    expect(disk.uploads).toEqual([])
    expect(disk.files.get("/notes.md")).toBe("another device's edit")
  })

  it("an existing file without --expected-fingerprint is refused with the words to read it first", async () => {
    const disk = harness()
    const refused = disk.run("/notes.md", "--text", NEW)
    await expect(refused).rejects.toMatchObject({ code: "validation_error" })
    await expect(refused).rejects.toThrow("disk personal files show /notes.md")
    await expect(disk.run("/notes.md", "--text", NEW, "--expected-fingerprint", "abc")).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(disk.uploads).toEqual([])
  })

  it("a new file needs no hash and asks no delete key; its text can come on stdin", async () => {
    const disk = harness(NEW)
    await disk.run("/new.md")
    expect(disk.files.get("/new.md")).toBe(NEW)
    expect(disk.asked).toEqual([[]])
    expect(disk.item()).toMatchObject({ path: "/new.md", sha256: sha256(NEW), replaced: null })
    expect(disk.uploads).toEqual([{ path: "/new.md", expect: { absent: true } }])
  })

  it("a hash for a file that is gone is a conflict; an empty stdin is a missing --text", async () => {
    const disk = harness("")
    await expect(disk.run("/gone.md", "--text", NEW, "--expected-fingerprint", sha256(OLD))).rejects.toMatchObject({
      code: "conflict",
    })
    await expect(disk.run("/new.md")).rejects.toMatchObject({ code: "validation_error" })
    await expect(harness().run("/new.md")).rejects.toMatchObject({ code: "validation_error" })
    expect(disk.uploads).toEqual([])
  })

  it("is a remote write, so an MCP catalogue lists it among the writes", () => {
    expect(metaOf(harness().update).effects).toMatchObject({ remote: "write" })
  })

  it("the service alone answers the kept version", async () => {
    const disk = harness()
    const from = join(mkdtempSync(join(tmpdir(), "file-update-")), "new.md")
    writeFileSync(from, NEW)
    const done = await guardedFileWrite({
      target: disk.target,
      versions: disk.versions,
      path: "/notes.md",
      from,
      expected: sha256(OLD),
      reread: "read it",
    })
    expect(done).toMatchObject({ file: { sha256: sha256(NEW) }, replaced: { sha256: sha256(OLD) } })
  })
})
