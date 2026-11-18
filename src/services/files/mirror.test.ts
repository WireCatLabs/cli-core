import { createHash } from "node:crypto"
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { readdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, posix } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CliError, isCliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { Expect, FileEntry, FileTarget, RemoteFile } from "../../documents/file-mirror-model.js"
import type { Keep } from "../../documents/push-model.js"
import { type Mirror, mirrorId } from "../documents/mirrors.js"
import { hashFile, localTemp } from "../documents/push.js"
import {
  type FileMirrorOptions,
  fileMirrorStatus,
  fileRemoteChanges,
  fileSyncState,
  syncFileMirror,
  syncFileMirrors,
} from "./mirror.js"

const reads = vi.hoisted(() => [] as string[])
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return {
    ...fs,
    readFile: (path: never, ...rest: never[]) => {
      reads.push(String(path))
      return fs.readFile(path, ...rest)
    },
  }
})

const FOLDER = "/Notes"
const TODAY = Date.parse("2026-11-18T12:00:00.000Z")
const hashes = (text: string) => ({
  sha256: createHash("sha256").update(text).digest("hex"),
  md5: createHash("md5").update(text).digest("hex"),
})
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
const put = (root: string, path: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}
/** Every file under `root` but hidden ones, with its text. */
const tree = async (root: string): Promise<Record<string, string>> => {
  const found: Record<string, string> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = posix.relative(root, join(entry.parentPath, entry.name))
    if (entry.isFile() && !path.split("/").some((part) => part.startsWith(".")))
      found[path] = readFileSync(join(root, path), "utf8")
  }
  return found
}

/** A remote folder kept on disk (content) with ids and a revision in memory, strict about `expect`. */
const fakeDisk = () => {
  const dir = temp("file-mirror-remote-")
  const ids = new Map<string, string>()
  const trash: { path: string; content: string }[] = []
  const calls: { op: string; path: string; expect?: Expect }[] = []
  let next = 0
  let revision = 0
  let gone = false
  const relative = (path: string) => posix.relative(FOLDER, path)
  const touch = (path: string) => {
    if (!ids.has(path)) ids.set(path, `res-${++next}`)
    revision++
  }
  const describe = async (path: string): Promise<RemoteFile> => {
    const { sha256, md5 } = await hashFile(join(dir, path))
    return {
      path,
      id: ids.get(path) as string,
      size: statSync(join(dir, path)).size,
      sha256,
      md5,
      modifiedAt: "2026-11-18T10:00:00.000Z",
    }
  }
  const check = async (path: string, expect: Expect) => {
    const here = existsSync(join(dir, path)) ? await describe(path) : undefined
    const ok = "absent" in expect ? !here : here?.sha256 === expect.sha256 && (!expect.md5 || here?.md5 === expect.md5)
    if (!ok) throw new CliError("conflict", "the remote file is not as expected")
  }
  const target: FileTarget = {
    identity: async () => "alpha",
    list: async (root) => {
      if (gone || root !== FOLDER) return undefined
      const files: RemoteFile[] = []
      for (const path of [...ids.keys()].sort()) files.push(await describe(path))
      return { rootId: "root-1", files }
    },
    download: async (path, into) => {
      calls.push({ op: "download", path: relative(path) })
      await pipeline(createReadStream(join(dir, relative(path))), createWriteStream(into, { flags: "wx" }))
    },
    upload: async (path, from, expect) => {
      const at = relative(path)
      calls.push({ op: "upload", path: at, expect })
      await check(at, expect)
      mkdirSync(dirname(join(dir, at)), { recursive: true })
      await pipeline(createReadStream(from), createWriteStream(join(dir, at)))
      touch(at)
      return describe(at)
    },
    trash: async (path, expect) => {
      const at = relative(path)
      calls.push({ op: "trash", path: at, expect })
      await check(at, expect)
      trash.push({ path: at, content: readFileSync(join(dir, at), "utf8") })
      await unlink(join(dir, at))
      ids.delete(at)
      revision++
    },
    ensureFolder: async (path) => {
      calls.push({ op: "folder", path: relative(path) })
      mkdirSync(join(dir, relative(path)), { recursive: true })
    },
    revision: async () => String(revision),
  }
  return {
    target,
    calls,
    trash,
    /** Another client writes the file; an overwrite keeps its id. */
    write: (path: string, content: string | Uint8Array) => {
      put(dir, path, content)
      touch(path)
    },
    /** Another client uploads a local file, streamed. */
    writeFrom: async (path: string, from: string) => {
      await pipeline(createReadStream(from), createWriteStream(join(dir, path)))
      touch(path)
    },
    remove: (path: string) => {
      rmSync(join(dir, path))
      ids.delete(path)
      revision++
    },
    move: (from: string, to: string) => {
      put(dir, to, readFileSync(join(dir, from)))
      rmSync(join(dir, from))
      ids.set(to, ids.get(from) as string)
      ids.delete(from)
      revision++
    },
    files: () => tree(dir),
    idOf: (path: string) => ids.get(path),
    goAway: () => {
      gone = true
    },
    writes: () => calls.filter((call) => call.op !== "folder"),
  }
}

class Crash extends Error {}

const setup = (local: Record<string, string> = {}, remote: Record<string, string> = {}) => {
  const root = temp("file-mirror-local-")
  for (const [path, content] of Object.entries(local)) put(root, path, content)
  const disk = fakeDisk()
  for (const [path, content] of Object.entries(remote)) disk.write(path, content)
  const stateDir = temp("file-mirror-state-")
  const mirror: Mirror = { id: mirrorId(root, FOLDER), path: root, folder: FOLDER }
  const port = fileSyncState(stateDir, mirror, "alpha")
  let crashed = false
  let crashAt: { action: string; side: string; when: "before" | "after" } | undefined
  const attempts: { action: string; side: string; path: string }[] = []
  let ops = 0
  const options = (extra: Partial<FileMirrorOptions> = {}): FileMirrorOptions => ({
    root,
    folder: FOLDER,
    target: disk.target,
    // A crashed process saves nothing more.
    state: { read: port.read, save: (state) => (crashed ? undefined : port.save(state)) },
    principal: "alpha",
    remote: "disk",
    guard: async (attempt, act) => {
      attempts.push({ action: attempt.action, side: attempt.side, path: attempt.path })
      const hit = crashAt && crashAt.action === attempt.action && crashAt.side === attempt.side ? crashAt : undefined
      if (hit?.when === "before") {
        crashed = true
        throw new Crash()
      }
      const done = await act()
      if (hit) {
        crashed = true
        throw new Crash()
      }
      return done
    },
    operationId: () => `op${String(++ops).padStart(6, "0")}`,
    errorOf: (error) => {
      if (error instanceof Crash) throw error
      return isCliError(error) ? error : new CliError("provider_error", String(error))
    },
    assertHeld: () => {},
    now: () => TODAY,
    ...extra,
  })
  const sync = (keep?: Keep, extra: Partial<FileMirrorOptions> = {}) =>
    syncFileMirror(options({ ...(keep ? { keep } : {}), ...extra }))
  return {
    root,
    disk,
    mirror,
    port,
    stateDir,
    attempts,
    sync,
    options,
    local: () => tree(root),
    crashOn: (action: string, side: string, when: "before" | "after") => {
      crashAt = { action, side, when }
    },
    recover: () => {
      crashAt = undefined
      crashed = false
    },
  }
}

describe("syncFileMirror, first sync", () => {
  it("adopts files that are the same on both sides and moves nothing", async () => {
    const files = { "a.md": "one", "sub/b.txt": "two" }
    const { sync, disk, local } = setup(files, files)
    const result = await sync()
    expect(result).toMatchObject({ uploaded: [], downloaded: [], adopted: ["a.md", "sub/b.txt"], conflicts: [] })
    expect(disk.writes()).toEqual([])
    expect(await sync()).toMatchObject({ adopted: [], unchanged: 2 })
    expect(await local()).toEqual(files)
  })

  it("reports a file with different content as a conflict and overwrites neither side", async () => {
    const { sync, disk, local } = setup({ "a.md": "mine" }, { "a.md": "theirs" })
    const result = await sync()
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "a.md", reason: "created on both sides with different content", localSize: 4 }),
    ])
    expect(disk.writes()).toEqual([])
    expect(await local()).toEqual({ "a.md": "mine" })
    expect(await disk.files()).toEqual({ "a.md": "theirs" })
  })

  it("copies a file found on one side only to the other", async () => {
    const { sync, disk, local } = setup({ "up/a.md": "local" }, { "down/b.md": "remote" })
    const result = await sync()
    expect(result).toMatchObject({ uploaded: ["up/a.md"], downloaded: ["down/b.md"] })
    expect(disk.calls.find((call) => call.op === "upload")?.expect).toEqual({ absent: true })
    expect(disk.calls.filter((call) => call.op === "folder").map((call) => call.path)).toEqual(["up"])
    expect(await local()).toEqual(await disk.files())
  })
})

describe("syncFileMirror, the three-way table", () => {
  const synced = async (files: Record<string, string>) => {
    const context = setup(files, files)
    await context.sync()
    context.disk.calls.length = 0
    return context
  }

  it("uploads a local change, expecting the remote as the listing saw it", async () => {
    const context = await synced({ "a.md": "one", "b.md": "two" })
    put(context.root, "a.md", "one, edited")
    const result = await context.sync()
    expect(result).toMatchObject({ uploaded: ["a.md"], unchanged: 1 })
    expect(context.disk.calls[0]?.expect).toEqual(hashes("one"))
    expect(await context.disk.files()).toMatchObject({ "a.md": "one, edited" })
  })

  it("downloads a remote change", async () => {
    const context = await synced({ "a.md": "one" })
    context.disk.write("a.md", "one, from the disk")
    expect(await context.sync()).toMatchObject({ downloaded: ["a.md"], uploaded: [] })
    expect(await context.local()).toEqual({ "a.md": "one, from the disk" })
  })

  it("adopts the same change made on both sides and reports different ones as a conflict", async () => {
    const context = await synced({ "same.md": "x", "torn.md": "y" })
    put(context.root, "same.md", "x2")
    context.disk.write("same.md", "x2")
    put(context.root, "torn.md", "y local")
    context.disk.write("torn.md", "y remote")
    const result = await context.sync()
    expect(result.adopted).toEqual(["same.md"])
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "torn.md", reason: "changed on both sides", remoteSize: 8, localSize: 7 }),
    ])
    expect(context.disk.writes()).toEqual([])
    expect(await context.local()).toMatchObject({ "torn.md": "y local" })
  })

  it("sends a local deletion to the remote trash with the expected md5", async () => {
    const context = await synced({ "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" })
    rmSync(join(context.root, "a.md"))
    const result = await context.sync()
    expect(result.trashed).toEqual([{ path: "a.md", side: "remote" }])
    expect(context.disk.calls[0]).toEqual({ op: "trash", path: "a.md", expect: hashes("1") })
    expect(context.disk.trash).toEqual([{ path: "a.md", content: "1" }])
  })

  it("moves a remote deletion into the local trash folder, never deleting it", async () => {
    const context = await synced({ "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" })
    context.disk.remove("a.md")
    expect((await context.sync()).trashed).toEqual([{ path: "a.md", side: "local" }])
    expect(await context.local()).not.toHaveProperty("a.md")
    expect(readFileSync(join(context.root, ".wirecat-trash", "2026-11-18", "a.md"), "utf8")).toBe("1")
  })

  it("forgets a file deleted on both sides", async () => {
    const context = await synced({ "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" })
    rmSync(join(context.root, "a.md"))
    context.disk.remove("a.md")
    expect(await context.sync()).toMatchObject({ trashed: [], conflicts: [] })
    expect(Object.keys(context.port.read().entries)).toEqual(["b.md", "c.md", "d.md"])
  })

  it("reports a deletion against a change as a conflict, settled only by --keep", async () => {
    const context = await synced({ "gone-here.md": "1", "gone-there.md": "2", "c.md": "3", "d.md": "4" })
    rmSync(join(context.root, "gone-here.md"))
    context.disk.write("gone-here.md", "1, changed")
    put(context.root, "gone-there.md", "2, changed")
    context.disk.remove("gone-there.md")
    const result = await context.sync()
    expect(result.conflicts.map((conflict) => [conflict.path, conflict.reason])).toEqual([
      ["gone-here.md", "deleted here, changed on the remote"],
      ["gone-there.md", "changed here, deleted on the remote"],
    ])
    expect(context.disk.writes()).toEqual([])

    const kept = await context.sync("remote")
    expect(kept).toMatchObject({ downloaded: ["gone-here.md"], trashed: [{ path: "gone-there.md", side: "local" }] })
    expect(await context.local()).toEqual({ "gone-here.md": "1, changed", "c.md": "3", "d.md": "4" })
  })

  it("--keep local keeps the changed local file against a remote deletion, and deletes against a remote change", async () => {
    const context = await synced({ "gone-here.md": "1", "gone-there.md": "2", "c.md": "3", "d.md": "4" })
    rmSync(join(context.root, "gone-here.md"))
    context.disk.write("gone-here.md", "1, changed")
    put(context.root, "gone-there.md", "2, changed")
    context.disk.remove("gone-there.md")
    const result = await context.sync("local", { allowDeletions: 1 })
    expect(result).toMatchObject({ uploaded: ["gone-there.md"], trashed: [{ path: "gone-here.md", side: "remote" }] })
    expect(await context.disk.files()).toEqual({ "gone-there.md": "2, changed", "c.md": "3", "d.md": "4" })
  })
})

describe("syncFileMirror, --keep on a file changed on both sides", () => {
  const torn = async () => {
    const context = setup({ "notes/a.md": "base" }, { "notes/a.md": "base" })
    await context.sync()
    put(context.root, "notes/a.md", "local")
    context.disk.write("notes/a.md", "remote")
    context.disk.calls.length = 0
    return context
  }

  it("local overwrites the remote, expecting what the listing saw", async () => {
    const context = await torn()
    expect(await context.sync("local")).toMatchObject({ uploaded: ["notes/a.md"], conflicts: [] })
    expect(await context.disk.files()).toEqual({ "notes/a.md": "local" })
  })

  it("remote overwrites the local file", async () => {
    const context = await torn()
    expect(await context.sync("remote")).toMatchObject({ downloaded: ["notes/a.md"], conflicts: [] })
    expect(await context.local()).toEqual({ "notes/a.md": "remote" })
  })

  it("both keeps the remote version as a dated copy on both sides, with nothing left to sync", async () => {
    const context = await torn()
    const result = await context.sync("both")
    const copy = "notes/a (conflict 2026-11-18 disk).md"
    expect(result).toMatchObject({ downloaded: [copy], uploaded: ["notes/a.md", copy], conflicts: [] })
    const both = { "notes/a.md": "local", [copy]: "remote" }
    expect(await context.local()).toEqual(both)
    expect(await context.disk.files()).toEqual(both)
    context.disk.calls.length = 0
    expect(await context.sync()).toMatchObject({ unchanged: 2, adopted: [], conflicts: [] })
    expect(context.disk.writes()).toEqual([])
  })
})

describe("syncFileMirror, deletion guard", () => {
  it("stops before any write when a run would delete more than a quarter of the mirror", async () => {
    const files = { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" }
    const context = setup(files, files)
    await context.sync()
    rmSync(join(context.root, "a.md"))
    rmSync(join(context.root, "b.md"))
    put(context.root, "new.md", "n")
    expect(await context.sync(undefined, { dryRun: true })).toMatchObject({ tooManyDeletions: 2 })
    await expect(context.sync()).rejects.toMatchObject({
      code: "confirmation_required",
      details: { reason: "mirror.too-many-deletions", deletions: 2 },
    })
    expect(context.disk.writes()).toEqual([])
    expect(await context.sync(undefined, { allowDeletions: 2 })).toMatchObject({ uploaded: ["new.md"] })
    expect(context.disk.trash.map((item) => item.path)).toEqual(["a.md", "b.md"])
  })

  it("stops at more than 50 deletions whatever the share", async () => {
    const files = Object.fromEntries(Array.from({ length: 220 }, (_, n) => [`f${n}.md`, `${n}`]))
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 51; n++) rmSync(join(context.root, `f${n}.md`))
    await expect(context.sync()).rejects.toMatchObject({ details: { deletions: 51 } })
  })
})

describe("syncFileMirror, renames", () => {
  it("renames the local file when the remote file moved, found by its id", async () => {
    const files = { "a.md": "1", "b.md": "2" }
    const context = setup(files, files)
    await context.sync()
    const id = context.disk.idOf("a.md")
    context.disk.move("a.md", "archive/a.md")
    context.disk.calls.length = 0
    const result = await context.sync()
    expect(result).toMatchObject({ renamed: [{ from: "a.md", to: "archive/a.md" }], trashed: [], downloaded: [] })
    expect(context.disk.calls).toEqual([])
    expect(await context.local()).toEqual({ "archive/a.md": "1", "b.md": "2" })
    expect(context.port.read().entries["archive/a.md"]?.id).toBe(id)
    expect(await context.sync()).toMatchObject({ unchanged: 2 })
  })

  it("treats a local rename as a deletion and a new file", async () => {
    const files = { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" }
    const context = setup(files, files)
    await context.sync()
    put(context.root, "renamed.md", "1")
    rmSync(join(context.root, "a.md"))
    const result = await context.sync()
    expect(result).toMatchObject({ uploaded: ["renamed.md"], trashed: [{ path: "a.md", side: "remote" }] })
    expect(await context.disk.files()).toEqual(await context.local())
  })
})

describe("syncFileMirror, crash and resume", () => {
  const files = { "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" }
  const rest = { "b.md": "b", "c.md": "c", "d.md": "d" }
  const cases: [string, string, (context: ReturnType<typeof setup>) => void, Record<string, string>][] = [
    ["create", "remote", (context) => put(context.root, "new.md", "new"), { ...files, "new.md": "new" }],
    ["update", "remote", (context) => put(context.root, "a.md", "a2"), { ...files, "a.md": "a2" }],
    ["create", "local", (context) => context.disk.write("new.md", "new"), { ...files, "new.md": "new" }],
    ["update", "local", (context) => context.disk.write("a.md", "a2"), { ...files, "a.md": "a2" }],
    ["delete", "remote", (context) => rmSync(join(context.root, "a.md")), rest],
    ["delete", "local", (context) => context.disk.remove("a.md"), rest],
    ["move", "local", (context) => context.disk.move("a.md", "moved/a.md"), { ...rest, "moved/a.md": "a" }],
  ]
  for (const [action, side, change, after] of cases)
    for (const when of ["before", "after"] as const)
      it(`settles a crash ${when} a ${side} ${action} with no loss and no duplicate`, async () => {
        const context = setup(files, files)
        await context.sync()
        change(context)
        context.crashOn(action, side, when)
        await expect(context.sync()).rejects.toBeInstanceOf(Crash)
        context.recover()
        const resumed = await context.sync()
        expect(resumed).toMatchObject({ conflicts: [], errors: [] })
        expect(await context.local()).toEqual(after)
        expect(await context.disk.files()).toEqual(after)
        expect(context.disk.trash.length).toBe(action === "delete" && side === "remote" ? 1 : 0)
        const trashed = join(context.root, ".wirecat-trash", "2026-11-18")
        expect(existsSync(trashed) ? await readdir(trashed) : []).toEqual(
          action === "delete" && side === "local" ? ["a.md"] : [],
        )
        expect(await context.sync()).toMatchObject({ unchanged: Object.keys(after).length, adopted: [] })
      })

  it("removes a download's temporary file left by a crash", async () => {
    const context = setup({}, { "a.md": "a" })
    const state = context.port.read()
    state.pending["a.md"] = { op: "download", operationId: "-4911" }
    context.port.save(state)
    const left = localTemp(join(context.root, "a.md"), createHash("sha256").update("-4911").digest("hex").slice(0, 8))
    writeFileSync(left, "half")
    await context.sync()
    expect(existsSync(left)).toBe(false)
    expect(context.port.read().pending).toEqual({})
    expect(await context.local()).toEqual({ "a.md": "a" })
  })

  it("does not retry a write whose outcome is unknown, and adopts it at the next listing", async () => {
    const context = setup({ "a.md": "a" })
    const upload = context.disk.target.upload
    let cut = true
    const target: FileTarget = {
      ...context.disk.target,
      upload: async (...args) => {
        await upload(...args)
        if (cut) {
          cut = false
          throw new CliError("outcome_unknown", "the connection dropped after sending")
        }
        throw new Error("must not upload again")
      },
    }
    const first = await context.sync(undefined, { target })
    expect(first.errors).toEqual([expect.objectContaining({ path: "a.md", code: "outcome_unknown" })])
    expect(context.port.read().pending["a.md"]).toMatchObject({ op: "upload" })
    const second = await context.sync(undefined, { target })
    expect(second).toMatchObject({ adopted: ["a.md"], errors: [] })
    expect(context.port.read().pending).toEqual({})
  })

  it("reports a remote file changed after the listing as a conflict and keeps both versions", async () => {
    const context = setup({ "a.md": "a" }, { "a.md": "a" })
    await context.sync()
    put(context.root, "a.md", "local")
    const list = context.disk.target.list
    const target: FileTarget = {
      ...context.disk.target,
      list: async (...args) => {
        const listed = await list(...args)
        context.disk.write("a.md", "sneaked in")
        return listed
      },
    }
    const result = await context.sync(undefined, { target })
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "a.md", reason: "the disk file changed during the sync" }),
    ])
    expect(await context.disk.files()).toEqual({ "a.md": "sneaked in" })
    expect(await context.local()).toEqual({ "a.md": "local" })
  })

  it("leaves a local file saved after the listing alone", async () => {
    const context = setup({ "a.md": "a" }, { "a.md": "a" })
    await context.sync()
    context.disk.write("a.md", "remote")
    const download = context.disk.target.download
    const target: FileTarget = {
      ...context.disk.target,
      download: async (...args) => {
        put(context.root, "a.md", "saved meanwhile")
        await download(...args)
      },
    }
    const result = await context.sync(undefined, { target })
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "a.md", reason: "the local file changed during the sync" }),
    ])
    expect(await context.local()).toEqual({ "a.md": "saved meanwhile" })
  })
})

describe("syncFileMirror, read-back checks", () => {
  it("never places a download whose content differs from the listing", async () => {
    const context = setup({}, { "a.md": "listed" })
    const target: FileTarget = {
      ...context.disk.target,
      download: async (_path, into) => writeFileSync(into, "something else", { flag: "wx" }),
    }
    const result = await context.sync(undefined, { target })
    expect(result.errors).toEqual([expect.objectContaining({ path: "a.md", code: "invalid_response" })])
    expect(await context.local()).toEqual({})
  })

  it("reports an upload that reads back with other content as a conflict and records nothing", async () => {
    const context = setup({ "a.md": "local" })
    const upload = context.disk.target.upload
    const target: FileTarget = {
      ...context.disk.target,
      upload: async (...args) => ({ ...(await upload(...args)), sha256: "other" }),
    }
    const result = await context.sync(undefined, { target })
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: "a.md", reason: "the local file changed during the upload" }),
    ])
    expect(context.port.read().entries).toEqual({})
  })
})

describe("syncFileMirror, content", () => {
  it("syncs binary and empty files byte for byte", async () => {
    const binary = Uint8Array.from({ length: 256 }, (_, n) => n)
    const context = setup()
    put(context.root, "blob.bin", binary)
    put(context.root, "empty.txt", "")
    context.disk.write("remote.bin", Uint8Array.from([0, 255, 0, 10, 13]))
    context.disk.write("remote-empty", "")
    const result = await context.sync()
    expect(result.uploaded).toEqual(["blob.bin", "empty.txt"])
    expect(result.downloaded).toEqual(["remote-empty", "remote.bin"])
    expect(readFileSync(join(context.root, "remote.bin"))).toEqual(Buffer.from([0, 255, 0, 10, 13]))
    expect(readFileSync(join(context.root, "remote-empty")).length).toBe(0)
    expect(await context.sync()).toMatchObject({ unchanged: 4 })
  })

  it("streams a large file both ways without reading it whole", async () => {
    const context = setup()
    const chunk = Buffer.alloc(1 << 20, 7)
    const big = join(context.root, "big.bin")
    await pipeline(
      Readable.from(
        (function* () {
          for (let n = 0; n < 50; n++) yield chunk
        })(),
      ),
      createWriteStream(big),
    )
    reads.length = 0
    expect(await context.sync()).toMatchObject({ uploaded: ["big.bin"] })
    await context.disk.writeFrom("copy.bin", big)
    expect(await context.sync()).toMatchObject({ downloaded: ["copy.bin"] })
    expect((await hashFile(join(context.root, "copy.bin"))).sha256).toBe((await hashFile(big)).sha256)
    expect(reads.filter((path) => path.endsWith(".bin"))).toEqual([])
  })
})

describe("syncFileMirror, refusals and dry run", () => {
  it("writes nothing on either side on a dry run, and still shows the plan", async () => {
    const context = setup({ "a.md": "1", "up.md": "u" }, { "a.md": "1", "down.md": "d" })
    const result = await context.sync(undefined, { dryRun: true })
    expect(result.plan).toEqual([
      { kind: "adopt", path: "a.md" },
      { kind: "download", path: "down.md" },
      { kind: "upload", path: "up.md" },
    ])
    expect(context.disk.calls).toEqual([])
    expect(context.attempts).toEqual([])
    expect(await context.local()).toEqual({ "a.md": "1", "up.md": "u" })
    expect(existsSync(join(context.stateDir, `${context.mirror.id}.json`))).toBe(false)
  })

  it("refuses a sync once the remote folder was moved or replaced", async () => {
    const context = setup({ "a.md": "1" })
    await context.sync()
    const list = context.disk.target.list
    const replaced: FileTarget = {
      ...context.disk.target,
      list: async (...args) => ({ ...(await list(...args)), rootId: "root-2" }) as never,
    }
    await expect(context.sync(undefined, { target: replaced })).rejects.toMatchObject({
      details: { reason: "mirror.root-moved" },
    })
    context.disk.goAway()
    await expect(context.sync()).rejects.toMatchObject({ details: { reason: "mirror.root-moved" } })
  })

  it("refuses another account", async () => {
    const context = setup()
    const target = { ...context.disk.target, identity: async () => "beta" }
    await expect(context.sync(undefined, { target })).rejects.toMatchObject({
      details: { reason: "profile.wrong-account" },
    })
  })

  it("skips hidden remote files and leaves a file without a hash for the next run", async () => {
    const context = setup()
    context.disk.write(".hidden", "h")
    context.disk.write("a.md", "1")
    const list = context.disk.target.list
    const target: FileTarget = {
      ...context.disk.target,
      list: async (...args) => {
        const listed = await list(...args)
        return listed && { ...listed, files: listed.files.map(({ sha256: _, ...file }) => file) }
      },
    }
    const result = await context.sync(undefined, { target })
    expect(result.errors).toEqual([expect.objectContaining({ path: "a.md" })])
    expect(await context.local()).toEqual({})
    expect((await context.sync()).downloaded).toEqual(["a.md"])
  })
})

describe("fileMirrorStatus and fileRemoteChanges", () => {
  it("lists local changes and deletions without asking the remote", async () => {
    const context = setup({ "a.md": "1", "b.md": "2" })
    await context.sync()
    put(context.root, "a.md", "1, edited")
    put(context.root, "c.md", "3")
    rmSync(join(context.root, "b.md"))
    const [item] = await fileMirrorStatus([context.mirror], () => context.port)
    expect(item).toMatchObject({ upload: ["a.md", "c.md"], delete: ["b.md"], unchanged: 0, remote_checked: false })
  })

  it("does not read a file again whose size and mtime match the last sync", async () => {
    const context = setup({ "a.md": "1" })
    await context.sync()
    const state = context.port.read()
    state.entries["a.md"] = { ...(state.entries["a.md"] as FileEntry), sha256: "kept" }
    context.port.save(state)
    expect((await fileMirrorStatus([context.mirror], () => context.port))[0]).toMatchObject({
      upload: [],
      unchanged: 1,
    })
  })

  it("lists again only when the remote revision moved", async () => {
    const { disk } = setup()
    const changes = fileRemoteChanges(disk.target)
    const signal = new AbortController().signal
    expect(await changes(signal)).toBe("all")
    expect(await changes(signal)).toEqual([])
    disk.write("a.md", "1")
    expect(await changes(signal)).toBe("all")
    expect(await changes(signal)).toEqual([])
    const { revision: _, ...plain } = disk.target
    expect(await fileRemoteChanges(plain)(signal)).toBe("all")
  })
})

describe("syncFileMirrors", () => {
  it("reports conflicts with the remote named and one partial issue, and releases the lock", async () => {
    const context = setup({ "a.md": "mine" }, { "a.md": "theirs" })
    const lock = { assertHeld: vi.fn(), release: vi.fn() }
    const { root: _, folder: __, state: ___, assertHeld: ____, ...rest } = context.options()
    const result = await syncFileMirrors({
      ...rest,
      mirrors: [context.mirror],
      stateOf: () => context.port,
      lock: async () => lock,
    })
    expect(result.items[0]?.conflicts[0]).toEqual(
      expect.objectContaining({ path: "a.md", local_size: 4, disk_size: 6, disk_changed_at: expect.any(String) }),
    )
    expect(result.items[0]?.conflicts[0]).not.toHaveProperty("url")
    expect(result.issues).toEqual([
      { code: "provider_error", reason: "mirror.partial", source: `mirror ${context.mirror.id}` },
    ])
    expect(lock.release).toHaveBeenCalledOnce()
  })
})
