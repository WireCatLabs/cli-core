import { createHash } from "node:crypto"
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
import { skippedName } from "../../documents/index.js"
import type { Keep } from "../../documents/push-model.js"
import { type Mirror, mirrorId } from "../documents/mirrors.js"
import { hashFile, localTemp, placeNew, safePath } from "../documents/push.js"
import { excludedBy, exclusionPattern } from "./exclusions.js"
import {
  type FileMirrorOptions,
  fileMirrorStatus,
  fileRemoteChanges,
  fileSyncState,
  syncFileMirror,
  syncFileMirrors,
} from "./mirror.js"
import { fileVersions, restoreFileVersion } from "./versions.js"

const reads = vi.hoisted(() => [] as string[])
const links = vi.hoisted(() => ({ refused: false }))
const vanished = vi.hoisted(() => new Set<string>())
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return {
    ...fs,
    // As exFAT, FAT and many FUSE or SMB mounts answer.
    link: (...args: Parameters<typeof fs.link>) =>
      links.refused
        ? Promise.reject(Object.assign(new Error("operation not permitted"), { code: "EPERM" }))
        : fs.link(...args),
    stat: (path: never, ...rest: never[]) =>
      vanished.has(String(path))
        ? Promise.reject(Object.assign(new Error("no such file"), { code: "ENOENT" }))
        : fs.stat(path, ...rest),
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
  let complete = true
  let rootId = "root-1"
  const unlisted = new Set<string>()
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
      for (const path of [...ids.keys()].sort()) if (!unlisted.has(path)) files.push(await describe(path))
      return { rootId, files, complete }
    },
    exists: async (path) => ids.has(relative(path)),
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
    /** The next listings skip a page, as a provider's capped or failed page would. */
    listPartly: () => {
      complete = false
    },
    replaceRoot: () => {
      rootId = "root-2"
    },
    /** The listing leaves the file out while it is still there, as a page that shifted or a lagging index would. */
    unlist: (path: string) => {
      unlisted.add(path)
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
  const versions = fileVersions(join(stateDir, "versions", mirror.id), () => TODAY)
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
    versions,
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
    versions,
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
    expect(context.disk.calls.find((call) => call.op === "upload")?.expect).toEqual(hashes("one"))
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
    expect(context.disk.calls.find((call) => call.op === "trash")).toEqual({
      op: "trash",
      path: "a.md",
      expect: hashes("1"),
    })
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
    const result = await context.sync("local")
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

  it("both records the copy only once it is uploaded, so a failed upload leaves it to send, never to delete", async () => {
    const context = await torn()
    const copy = "notes/a (conflict 2026-11-18 disk).md"
    const upload = context.disk.target.upload
    const target: FileTarget = {
      ...context.disk.target,
      upload: async (path, ...rest) => {
        if (path.endsWith(copy)) throw new CliError("provider_unavailable", "the connection dropped")
        return upload(path, ...rest)
      },
    }
    const first = await context.sync("both", { target })
    expect(first.errors).toEqual([expect.objectContaining({ path: "notes/a.md", code: "provider_unavailable" })])
    expect(context.port.read().entries).not.toHaveProperty([copy])
    expect(await context.sync()).toMatchObject({ uploaded: [copy], trashed: [], errors: [] })
    const both = { "notes/a.md": "local", [copy]: "remote" }
    expect(await context.local()).toEqual(both)
    expect(await context.disk.files()).toEqual(both)
  })
})

describe("syncFileMirror, the guard on mass changes", () => {
  const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`f${n}.md`, `${n}`]))
  const hints = {
    preview: "ydisk work mirrors preview <id>",
    sync: "ydisk work mirrors sync <id>",
    allowDeletions: "--allow-deletions <count>",
    allowReplacements: "--allow-replacements <count>",
  }

  it("lets up to 10 deletions through, however large or small the mirror", async () => {
    const files = many(12)
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 10; n++) rmSync(join(context.root, `f${n}.md`))
    expect(await context.sync(undefined, { dryRun: true })).not.toHaveProperty("tooManyDeletions")
    expect((await context.sync()).trashed).toHaveLength(10)
  })

  it("stops at 11 deletions in a mirror of 1,000 files, before any write, naming the command that allows them", async () => {
    const files = many(1_000)
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 11; n++) rmSync(join(context.root, `f${n}.md`))
    put(context.root, "new.md", "n")
    context.disk.calls.length = 0
    expect(await context.sync(undefined, { dryRun: true })).toMatchObject({ tooManyDeletions: 11 })
    const stopped = await context.sync(undefined, { id: "1a2b3c4d", hints })
    expect(stopped).toMatchObject({ tooManyDeletions: 11, uploaded: [], trashed: [] })
    expect(stopped.errors).toEqual([
      {
        path: ".",
        code: "confirmation_required",
        reason: "mirror.too-many-deletions",
        message:
          "this sync would delete 11 files (more than 10); check them with `ydisk work mirrors preview 1a2b3c4d`, " +
          "then allow them with `ydisk work mirrors sync 1a2b3c4d --allow-deletions 11`",
      },
    ])
    expect(context.disk.writes()).toEqual([])
    expect(await context.sync(undefined, { allowDeletions: 10 })).toMatchObject({ trashed: [] })
    const allowed = await context.sync(undefined, { allowDeletions: 11 })
    expect(allowed).toMatchObject({ uploaded: ["new.md"], errors: [] })
    expect(allowed.trashed).toHaveLength(11)
  })

  it("stops at more than 50 replacements on either side, as an editor or ransomware rewriting every file would", async () => {
    const files = many(60)
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 30; n++) put(context.root, `f${n}.md`, `${n}, encrypted`)
    for (let n = 30; n < 51; n++) context.disk.write(`f${n}.md`, `${n}, encrypted`)
    context.disk.calls.length = 0
    const stopped = await context.sync(undefined, { id: "1a2b3c4d", hints })
    expect(stopped.errors).toEqual([
      expect.objectContaining({
        code: "confirmation_required",
        reason: "mirror.too-many-replacements",
        message: expect.stringContaining(
          "replace 51 existing files (more than 50); check them with `ydisk work mirrors preview 1a2b3c4d`, then " +
            "allow them with `ydisk work mirrors sync 1a2b3c4d --allow-replacements 51`",
        ),
      }),
    ])
    expect(context.disk.writes()).toEqual([])
    expect(await context.local()).toMatchObject({ "f40.md": "40" })
    const allowed = await context.sync(undefined, { allowReplacements: 51 })
    expect([allowed.uploaded.length, allowed.downloaded.length]).toEqual([30, 21])
  })

  it("lets 50 replacements through", async () => {
    const files = many(50)
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 50; n++) put(context.root, `f${n}.md`, `${n}, edited`)
    expect((await context.sync()).uploaded).toHaveLength(50)
  })

  it("names every count over the limit, so one approved run is enough", async () => {
    const files = many(70)
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 11; n++) rmSync(join(context.root, `f${n}.md`))
    for (let n = 11; n < 70; n++) put(context.root, `f${n}.md`, `${n}, edited`)
    const stopped = await context.sync(undefined, { id: "1a2b3c4d", hints, allowReplacements: 59 })
    expect(stopped.errors[0]).toMatchObject({ reason: "mirror.too-many-deletions" })
    expect(stopped.errors[0]?.message).toContain(
      "`ydisk work mirrors sync 1a2b3c4d --allow-deletions 11 --allow-replacements 59`",
    )
    const allowed = await context.sync(undefined, { allowDeletions: 11, allowReplacements: 59 })
    expect([allowed.trashed.length, allowed.uploaded.length]).toEqual([11, 59])
  })

  it("stops only the mirror over the limit: the next one still syncs, and each run reports the stop", async () => {
    const files = many(12)
    const big = setup(files, files)
    await big.sync()
    for (let n = 0; n < 11; n++) rmSync(join(big.root, `f${n}.md`))
    const small = setup({ "a.md": "1" })
    const lock = { assertHeld: vi.fn(), release: vi.fn() }
    const run = () =>
      syncFileMirrors({
        target: big.disk.target,
        principal: "alpha",
        remote: "disk",
        guard: (_attempt, act) => act(),
        operationId: () => "op",
        errorOf: (error) => (isCliError(error) ? error : new CliError("provider_error", String(error))),
        mirrors: [big.mirror, { ...small.mirror, folder: FOLDER }],
        stateOf: (mirror) => (mirror.path === big.root ? big.port : small.port),
        versionsOf: (mirror) => (mirror.path === big.root ? big.versions : small.versions),
        lock: async () => lock,
      })
    const first = await run()
    expect(first.items[0]?.errors[0]).toMatchObject({ reason: "mirror.too-many-deletions" })
    expect(first.items[1]).toMatchObject({ errors: [], unknown: [] })
    expect(first.issues).toEqual([
      { code: "provider_error", reason: "mirror.partial", source: `mirror ${big.mirror.id}` },
    ])
    expect((await run()).items[0]?.errors[0]).toMatchObject({ reason: "mirror.too-many-deletions" })
    expect(big.disk.trash).toEqual([])
  })
})

describe("syncFileMirror, free space", () => {
  it("downloads nothing when the drive would keep less than 100 MB free, and says how much it needs", async () => {
    const context = setup({}, { "big.bin": "x".repeat(2_000) })
    const free = 100 * 1024 ** 2 + 1_000
    const space = async () => ({ free, dev: 1 })
    const preview = await context.sync(undefined, { dryRun: true, space })
    expect(preview.noSpace).toEqual({ path: context.root, needed: 2_000, free })
    const stopped = await context.sync(undefined, { space, hints: { exclude: "mirrors exclude <id> <glob>" } })
    expect(stopped.errors).toEqual([
      expect.objectContaining({
        code: "validation_error",
        reason: "mirror.no-space",
        message: expect.stringContaining("leave big folders out with `mirrors exclude <id> <glob>`"),
      }),
    ])
    expect(await context.local()).toEqual({})
    expect(await context.sync(undefined, { space: async () => ({ free: free + 1_000, dev: 1 }) })).toMatchObject({
      downloaded: ["big.bin"],
    })
  })

  it("counts the versions a pull keeps on the store's own drive when it is another one", async () => {
    const context = setup({ "a.md": "old" }, { "a.md": "old" })
    await context.sync()
    context.disk.write("a.md", "new, longer")
    const space = async (path: string) =>
      path === context.root ? { free: 10 * 1024 ** 3, dev: 1 } : { free: 100 * 1024 ** 2, dev: 2 }
    const stopped = await context.sync(undefined, { space })
    expect(stopped.noSpace).toEqual({
      path: expect.stringContaining(context.stateDir),
      needed: 3,
      free: 100 * 1024 ** 2,
    })
    expect(await context.local()).toEqual({ "a.md": "old" })
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

  it("never removes a leftover temporary file through a folder replaced by a symbolic link", async () => {
    const context = setup({}, { "sub/a.md": "a" })
    const state = context.port.read()
    state.pending["sub/a.md"] = { op: "download", operationId: "-4911" }
    context.port.save(state)
    const outside = temp("file-mirror-outside-")
    const left = localTemp(join(outside, "a.md"), createHash("sha256").update("-4911").digest("hex").slice(0, 8))
    writeFileSync(left, "not the mirror's")
    symlinkSync(outside, join(context.root, "sub"))
    const result = await context.sync()
    expect(existsSync(left)).toBe(true)
    expect(result.errors).toEqual([
      expect.objectContaining({ path: "sub/a.md", message: expect.stringContaining("link") }),
    ])
  })

  it("keeps a download's pending entry when a failed copy left a partial file behind", async () => {
    const context = setup({}, { "a.md": "full content" })
    const result = await context.sync(undefined, {
      guard: async () => {
        put(context.root, "a.md", "full")
        throw new CliError("provider_error", "the copy failed and its removal too")
      },
    })
    expect(result.errors).toEqual([expect.objectContaining({ path: "a.md" })])
    expect(context.port.read().pending["a.md"]).toMatchObject({ op: "download", created: true })
    expect((await context.sync("local")).conflicts).toEqual([
      expect.objectContaining({ path: "a.md", reason: expect.stringContaining("cut off") }),
    ])
    expect(await context.disk.files()).toEqual({ "a.md": "full content" })
  })

  it("clears a download's pending entry when it fails cleanly, an unknown outcome included", async () => {
    for (const code of ["network_error", "outcome_unknown"] as const) {
      const context = setup({}, { "a.md": "a" })
      const target: FileTarget = {
        ...context.disk.target,
        download: async () => {
          throw new CliError(code, "the connection dropped")
        },
      }
      expect((await context.sync(undefined, { target })).errors).toEqual([expect.objectContaining({ code })])
      expect(context.port.read().pending).toEqual({})
      expect(await context.sync()).toMatchObject({ downloaded: ["a.md"], conflicts: [] })
    }
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
    expect(context.versions.has(hashes("sneaked in").sha256)).toBe(true)
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

describe("syncFileMirror, a file missing from the listing", () => {
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`f${n}.md`, `${n}`]))

  it("is deleted only once a direct read after the listing finds nothing, and never counts toward the guard", async () => {
    const context = setup(files, files)
    await context.sync()
    for (let n = 0; n < 20; n++) context.disk.unlist(`f${n}.md`)
    context.disk.remove("f29.md")
    const result = await context.sync()
    expect(result).not.toHaveProperty("tooManyDeletions")
    expect(result.trashed).toEqual([{ path: "f29.md", side: "local" }])
    expect(result.unknown).toHaveLength(20)
    expect(result.unknown[0]).toEqual({
      path: "f0.md",
      side: "remote",
      reason: "missing from the disk listing, but still there",
    })
    expect(await context.local()).toMatchObject({ "f0.md": "0" })
  })

  it("deletes nothing when the direct read fails", async () => {
    const context = setup(files, files)
    await context.sync()
    context.disk.remove("f0.md")
    const target: FileTarget = {
      ...context.disk.target,
      exists: async () => {
        throw new CliError("provider_unavailable", "busy")
      },
    }
    const result = await context.sync(undefined, { target })
    expect(result.trashed).toEqual([])
    expect(result.unknown).toEqual([
      { path: "f0.md", side: "remote", reason: "the disk could not say whether it was deleted: busy" },
    ])
  })
})

describe("syncFileMirror, exclusions", () => {
  const files = { "a.md": "1", "Photos/1.jpg": "p1", "Photos/2019/2.jpg": "p2", "work/big.iso": "iso" }

  it("never sends anything to a trash on either side when an exclusion is added", async () => {
    const context = setup(files, files)
    await context.sync()
    context.disk.calls.length = 0
    const result = await context.sync(undefined, { exclude: ["Photos", "*.iso"] })
    expect(result).toMatchObject({ trashed: [], unknown: [], uploaded: [], downloaded: [], errors: [] })
    expect(context.disk.writes()).toEqual([])
    expect(context.disk.trash).toEqual([])
    expect(existsSync(join(context.root, ".wirecat-trash"))).toBe(false)
    expect(Object.keys(context.port.read().entries)).toEqual(["a.md"])
    rmSync(join(context.root, "Photos"), { recursive: true })
    context.disk.remove("work/big.iso")
    expect(await context.sync(undefined, { exclude: ["Photos", "*.iso"] })).toMatchObject({ trashed: [] })
    expect(await context.disk.files()).toMatchObject({ "Photos/1.jpg": "p1" })
    expect(await context.local()).toMatchObject({ "work/big.iso": "iso" })
  })

  it("syncs an excluded path as a new folder once the exclusion is removed: nothing is deleted", async () => {
    const context = setup(files, files)
    await context.sync()
    await context.sync(undefined, { exclude: ["Photos"] })
    rmSync(join(context.root, "Photos/1.jpg"))
    context.disk.write("Photos/2019/2.jpg", "p2, edited")
    const result = await context.sync()
    expect(result).toMatchObject({ trashed: [], downloaded: ["Photos/1.jpg"] })
    expect(result.conflicts).toEqual([expect.objectContaining({ path: "Photos/2019/2.jpg" })])
    expect(await context.local()).toMatchObject({ "Photos/1.jpg": "p1" })
  })

  it("leaves excluded files alone on both sides and keeps them out of the status", async () => {
    const context = setup({ "a.md": "1", "Photos/here.jpg": "h" }, { "Photos/there.jpg": "t" })
    const result = await context.sync(undefined, { exclude: ["/Photos"] })
    expect(result).toMatchObject({ uploaded: ["a.md"], downloaded: [] })
    expect(await context.disk.files()).toEqual({ "a.md": "1", "Photos/there.jpg": "t" })
    const mirror = { ...context.mirror, exclude: ["/Photos"] }
    expect((await fileMirrorStatus([mirror], () => context.port))[0]).toMatchObject({ upload: [], delete: [] })
  })

  it("renames a file moved into an excluded folder on the remote instead of deleting it, then leaves it", async () => {
    const context = setup(files, files)
    await context.sync()
    context.disk.move("a.md", "Photos/a.md")
    const result = await context.sync(undefined, { exclude: ["Photos"] })
    expect(result).toMatchObject({ trashed: [], renamed: [{ from: "a.md", to: "Photos/a.md" }], unknown: [] })
    expect(await context.local()).toMatchObject({ "Photos/a.md": "1" })
    expect(context.port.read().entries).not.toHaveProperty(["Photos/a.md"])
  })

  it("does not take a local folder whose files are all excluded for an unmounted drive", async () => {
    const context = setup({ "Photos/1.jpg": "p1" }, { "Photos/1.jpg": "p1" })
    await context.sync()
    expect(await context.sync(undefined, { exclude: ["Photos"] })).toMatchObject({ errors: [], unknown: [] })
  })

  it("reads names at any depth, paths from the root, and refuses patterns that leave the mirror", () => {
    const excluded = excludedBy(["node_modules", "*.iso", "/Camera", "Work/**/build", "Docs/?.md"])
    expect(
      ["a/node_modules/x.js", "deep/disk.iso", "Camera/1.jpg", "a/Camera/1.jpg", "Work/build/x", "Work/a/b/build/y"]
        .concat(["Docs/a.md", "Docs/ab.md", "notes.md"])
        .map(excluded),
    ).toEqual([true, true, true, false, true, true, true, false, false])
    expect(exclusionPattern(" Photos/ ")).toBe("Photos")
    for (const bad of ["", "/", "../x", "a/./b", "a//b"]) expect(() => exclusionPattern(bad)).toThrow(/path pattern/)
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
      versionsOf: () => context.versions,
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

describe("syncFileMirror, a deletion is proven or nothing is deleted", () => {
  const files = { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" }
  const synced = async () => {
    const context = setup(files, files)
    await context.sync()
    context.disk.calls.length = 0
    return context
  }
  const nothingDeleted = async (context: Awaited<ReturnType<typeof synced>>) => {
    expect(context.disk.trash).toEqual([])
    expect(existsSync(join(context.root, ".wirecat-trash"))).toBe(false)
  }

  it("does not delete locally a file missing from an incomplete remote listing, and reports it", async () => {
    const context = await synced()
    context.disk.remove("a.md")
    context.disk.listPartly()
    put(context.root, "b.md", "2, edited")
    const result = await context.sync()
    expect(result.unknown).toEqual([
      { path: "a.md", side: "remote", reason: "missing from an incomplete disk listing" },
    ])
    expect(result.uploaded).toEqual(["b.md"])
    await nothingDeleted(context)
    expect(await context.local()).toMatchObject({ "a.md": "1" })
  })

  it("deletes nothing when the remote listing fails", async () => {
    const context = await synced()
    rmSync(join(context.root, "a.md"))
    const target: FileTarget = {
      ...context.disk.target,
      list: async () => {
        throw new CliError("provider_unavailable", "page 2 failed")
      },
    }
    await expect(context.sync(undefined, { target })).rejects.toMatchObject({ code: "provider_unavailable" })
    await nothingDeleted(context)
  })

  it("deletes nothing on either side when the local folder is gone, empty or another folder", async () => {
    for (const change of ["gone", "empty", "replaced"] as const) {
      const context = await synced()
      context.disk.remove("a.md")
      if (change === "gone") rmSync(context.root, { recursive: true })
      else if (change === "empty") for (const name of Object.keys(files)) rmSync(join(context.root, name))
      else {
        // Moved aside, not deleted, so the new folder cannot reuse the old inode number.
        renameSync(context.root, `${context.root}-old`)
        mkdirSync(context.root)
        for (const name of ["b.md", "c.md", "d.md"]) put(context.root, name, files[name as "b.md"])
      }
      const result = await context.sync()
      expect(result.unknown).toHaveLength(4)
      expect(result.unknown[0]?.side).toBe("local")
      if (change === "empty") expect(result.errors[0]?.message).toContain("remove the mirror's state to start over")
      expect(context.disk.writes()).toEqual([])
      expect(await context.disk.files()).toEqual({ "b.md": "2", "c.md": "3", "d.md": "4" })
    }
  })

  it("deletes nothing on either side when the remote folder is gone or replaced", async () => {
    for (const change of ["gone", "replaced"] as const) {
      const context = await synced()
      rmSync(join(context.root, "a.md"))
      if (change === "gone") context.disk.goAway()
      else context.disk.replaceRoot()
      const result = await context.sync()
      expect(result.unknown.map((item) => [item.path, item.side])).toEqual(
        Object.keys(files).map((path) => [path, "remote"]),
      )
      expect(context.disk.writes()).toEqual([])
      expect(await context.local()).toEqual({ "b.md": "2", "c.md": "3", "d.md": "4" })
    }
  })

  it("never takes a file the last sync did not see as deleted, even from an incomplete listing", async () => {
    const context = await synced()
    put(context.root, "new.md", "n")
    context.disk.listPartly()
    expect(await context.sync()).toMatchObject({ uploaded: ["new.md"], unknown: [], trashed: [] })
  })

  it("counts the run as partial", async () => {
    const context = await synced()
    context.disk.remove("a.md")
    context.disk.listPartly()
    const { root: _, folder: __, state: ___, assertHeld: ____, versions: _____, ...rest } = context.options()
    const result = await syncFileMirrors({
      ...rest,
      mirrors: [context.mirror],
      stateOf: () => context.port,
      versionsOf: () => context.versions,
      lock: async () => ({ assertHeld: () => {}, release: () => {} }),
    })
    expect(result.issues).toEqual([expect.objectContaining({ reason: "mirror.partial" })])
  })
})

describe("syncFileMirror, local versions", () => {
  const synced = async () => {
    const files = { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" }
    const context = setup(files, files)
    await context.sync()
    return context
  }

  it("keeps the local content before a pull overwrites it, and logs the change", async () => {
    const context = await synced()
    context.disk.write("a.md", "1, from the disk")
    await context.sync()
    const [event] = context.versions.list("a.md")
    expect(event).toMatchObject({
      event: "changed",
      direction: "remote-to-local",
      old: hashes("1").sha256,
      new: hashes("1, from the disk").sha256,
      available: true,
    })
    const lock = { assertHeld: vi.fn(), release: vi.fn() }
    expect(await restoreFileVersion(context.root, "a.md", hashes("1").sha256, context.versions, async () => lock)).toBe(
      true,
    )
    expect(lock.assertHeld).toHaveBeenCalled()
    expect(lock.release).toHaveBeenCalledOnce()
    expect(await context.local()).toMatchObject({ "a.md": "1" })
    expect(context.versions.list("a.md").at(-1)).toMatchObject({
      direction: "restored",
      old: hashes("1, from the disk").sha256,
    })
    expect(await context.sync()).toMatchObject({ uploaded: ["a.md"] })
  })

  it("keeps a local file before --keep disk overwrites it and before a crossed deletion", async () => {
    const context = await synced()
    put(context.root, "a.md", "mine")
    context.disk.write("a.md", "theirs")
    context.disk.remove("b.md")
    await context.sync("remote")
    expect(context.versions.list("a.md")[0]).toMatchObject({ old: hashes("mine").sha256, available: true })
    expect(context.versions.list("b.md")[0]).toMatchObject({
      event: "deleted",
      old: hashes("2").sha256,
      available: true,
    })
  })

  it("logs the remote version an upload replaced", async () => {
    const context = await synced()
    put(context.root, "a.md", "1, edited")
    rmSync(join(context.root, "b.md"))
    await context.sync()
    expect(context.versions.list("a.md")).toEqual([
      expect.objectContaining({ event: "changed", direction: "local-to-remote", old: hashes("1").sha256 }),
    ])
    expect(context.versions.list("b.md")).toEqual([
      expect.objectContaining({ event: "deleted", direction: "local-to-remote", old: hashes("2").sha256 }),
    ])
  })

  it("keeps versions for 30 days, and the last version of a deleted file for good", async () => {
    const dir = temp("file-mirror-versions-")
    let clock = TODAY
    const versions = fileVersions(dir, () => clock)
    const file = join(temp("file-mirror-versions-src-"), "x")
    for (const text of ["old", "gone"]) {
      writeFileSync(file, text)
      await versions.keep(file)
    }
    versions.log({ path: "x", event: "changed", direction: "remote-to-local", old: hashes("old").sha256 })
    versions.log({ path: "y", event: "deleted", direction: "remote-to-local", old: hashes("gone").sha256 })
    clock += 31 * 24 * 60 * 60 * 1000
    await versions.prune()
    expect(versions.list("x")[0]?.available).toBe(false)
    expect(versions.list("y")[0]?.available).toBe(true)
  })

  it("keeps the remote content an upload replaces, downloading only what the store lacks", async () => {
    const context = await synced()
    put(context.root, "a.md", "1, edited")
    await context.versions.keep(join(context.root, "c.md"))
    put(context.root, "c.md", "3, edited")
    context.disk.calls.length = 0
    expect(await context.sync()).toMatchObject({ uploaded: ["a.md", "c.md"] })
    expect(context.disk.calls.filter((call) => call.op === "download").map((call) => call.path)).toEqual(["a.md"])
    for (const [path, old] of [
      ["a.md", "1"],
      ["c.md", "3"],
    ])
      expect(context.versions.list(path as string)).toEqual([
        expect.objectContaining({ old: hashes(old as string).sha256, from: "remote", available: true }),
      ])
  })

  it("downloads nothing before a remote deletion: the provider's trash holds the content", async () => {
    const context = await synced()
    await context.versions.keep(join(context.root, "b.md"))
    rmSync(join(context.root, "a.md"))
    rmSync(join(context.root, "b.md"))
    context.disk.calls.length = 0
    expect((await context.sync()).trashed).toHaveLength(2)
    expect(context.disk.calls.filter((call) => call.op === "download")).toEqual([])
    expect(context.versions.list("a.md")).toEqual([
      expect.objectContaining({ event: "deleted", from: "remote", oldIn: "remote-trash", available: false }),
    ])
    expect(context.versions.list("b.md")[0]).toMatchObject({ old: hashes("2").sha256, available: true })
    expect(context.versions.list("b.md")[0]).not.toHaveProperty("oldIn")
  })

  it("keeps the remote side of --keep both from the server when the copy was edited before it was kept", async () => {
    const context = await synced()
    put(context.root, "a.md", "mine")
    context.disk.write("a.md", "theirs")
    const keep = context.versions.keep
    const versions = {
      ...context.versions,
      keep: (source: string | ((temp: string) => Promise<void>)) => {
        if (typeof source === "string" && source.includes("(conflict")) writeFileSync(source, "edited copy")
        return keep(source)
      },
    }
    context.disk.calls.length = 0
    await context.sync("both", { versions })
    expect(context.disk.calls.filter((call) => call.op === "download")).toHaveLength(2)
    expect(context.versions.has(hashes("theirs").sha256)).toBe(true)
  })

  it("reports a full disk while a remote version is downloaded as mirror.version-not-kept", async () => {
    const versions = fileVersions(temp("file-mirror-full-"), () => TODAY)
    await expect(
      versions.keep(async () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" })
      }),
    ).rejects.toMatchObject({ code: "provider_error", details: { reason: "mirror.version-not-kept" } })
    await expect(
      versions.keep(async () => {
        throw new CliError("network_error", "the connection dropped")
      }),
    ).rejects.toMatchObject({ code: "network_error" })
  })

  it("keeps the remote side of --keep both from its local copy, with no second download", async () => {
    const context = await synced()
    put(context.root, "a.md", "mine")
    context.disk.write("a.md", "theirs")
    context.disk.calls.length = 0
    await context.sync("both")
    expect(context.disk.calls.filter((call) => call.op === "download")).toHaveLength(1)
    expect(context.versions.list("a.md")[0]).toMatchObject({ old: hashes("theirs").sha256, from: "remote" })
    expect(context.versions.has(hashes("theirs").sha256)).toBe(true)
  })

  it("replaces nothing when the version store cannot keep the old content", async () => {
    const context = await synced()
    const broken = temp("file-mirror-broken-")
    writeFileSync(join(broken, "objects"), "")
    const versions = fileVersions(broken, () => TODAY)
    await expect(versions.keep(join(context.root, "a.md"))).rejects.toMatchObject({
      code: "provider_error",
      details: { reason: "mirror.version-not-kept" },
    })
    context.disk.write("a.md", "from the disk")
    put(context.root, "b.md", "2, edited")
    const result = await context.sync(undefined, { versions })
    expect(result.errors).toEqual([
      expect.objectContaining({ path: "a.md", message: expect.stringContaining("could not be kept") }),
      expect.objectContaining({ path: "b.md", message: expect.stringContaining("could not be kept") }),
    ])
    expect(await context.local()).toMatchObject({ "a.md": "1", "b.md": "2, edited" })
    expect(await context.disk.files()).toMatchObject({ "a.md": "from the disk", "b.md": "2" })
    expect(context.port.read().pending).toEqual({})
  })

  it("writes no version and no log on a dry run", async () => {
    const context = await synced()
    context.disk.write("a.md", "changed")
    await context.sync(undefined, { dryRun: true })
    expect(context.versions.list("a.md")).toEqual([])
  })
})

describe("syncFileMirror, the version store survives a crash", () => {
  it("keeps the content a crash left without a log line", async () => {
    const files = { "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" }
    const context = setup(files, files)
    await context.sync()
    context.disk.write("a.md", "a2")
    context.crashOn("update", "local", "after")
    await expect(context.sync()).rejects.toBeInstanceOf(Crash)
    context.recover()
    expect(await context.sync()).toMatchObject({ adopted: ["a.md"], errors: [] })
    expect(existsSync(join(context.stateDir, "versions", context.mirror.id, "objects", hashes("a").sha256))).toBe(true)
  })

  it("prunes a content no log line names only 30 days after it was last kept", async () => {
    const dir = temp("file-mirror-versions-")
    let clock = TODAY
    const versions = fileVersions(dir, () => clock)
    const file = join(temp("file-mirror-versions-src-"), "x")
    const object = join(dir, "objects", hashes("x").sha256)
    writeFileSync(file, "x")
    await versions.keep(file)
    await versions.prune()
    expect(existsSync(object)).toBe(true)
    clock += 31 * 24 * 60 * 60 * 1000
    await versions.keep(file)
    await versions.prune()
    expect(existsSync(object)).toBe(true)
    clock += 31 * 24 * 60 * 60 * 1000
    await versions.prune()
    expect(existsSync(object)).toBe(false)
  })
})

describe("syncFileMirror, a root problem is never a complete run", () => {
  const partial = (context: ReturnType<typeof setup>) => {
    const { root: _, folder: __, state: ___, assertHeld: ____, versions: _____, ...rest } = context.options()
    return syncFileMirrors({
      ...rest,
      mirrors: [context.mirror],
      stateOf: () => context.port,
      versionsOf: () => context.versions,
      lock: async () => ({ assertHeld: () => {}, release: () => {} }),
    })
  }

  it("reports a remote folder that is gone at the first sync", async () => {
    const context = setup({ "a.md": "1" })
    context.disk.goAway()
    const result = await partial(context)
    expect(result.items[0]?.errors).toEqual([{ path: ".", code: "not_found", message: "the disk folder is gone" }])
    expect(result.issues).toEqual([expect.objectContaining({ reason: "mirror.partial" })])
  })

  it("reports a local folder that is gone at the first sync", async () => {
    const context = setup({}, { "a.md": "1" })
    rmSync(context.root, { recursive: true })
    const result = await partial(context)
    expect(result.items[0]?.errors).toEqual([expect.objectContaining({ path: ".", code: "not_found" })])
    expect(result.issues).toEqual([expect.objectContaining({ reason: "mirror.partial" })])
  })
})

describe("syncFileMirror, symbolic links and unusable paths", () => {
  const files = { "sub/a.md": "1", "sub/b.md": "2", "c.md": "3", "d.md": "4" }
  const synced = async () => {
    const context = setup(files, files)
    await context.sync()
    context.disk.calls.length = 0
    return context
  }

  it("takes files under a synced folder replaced by a link as unknown, and deletes nothing", async () => {
    const context = await synced()
    const outside = temp("file-mirror-outside-")
    renameSync(join(context.root, "sub"), join(outside, "sub"))
    symlinkSync(join(outside, "sub"), join(context.root, "sub"))
    const result = await context.sync()
    expect(result.unknown).toEqual([
      { path: "sub/a.md", side: "local", reason: "under a symbolic link, which the sync does not follow" },
      { path: "sub/b.md", side: "local", reason: "under a symbolic link, which the sync does not follow" },
    ])
    expect(context.disk.writes()).toEqual([])
    expect(await context.disk.files()).toEqual(files)
  })

  it("never writes through a linked folder or a linked trash", async () => {
    const context = await synced()
    const outside = temp("file-mirror-outside-")
    symlinkSync(outside, join(context.root, "out"))
    symlinkSync(outside, join(context.root, ".wirecat-trash"))
    context.disk.write("out/x.md", "x")
    context.disk.remove("c.md")
    const result = await context.sync()
    expect(result.errors).toEqual([
      expect.objectContaining({ path: "c.md", code: "validation_error" }),
      expect.objectContaining({ path: "out/x.md", code: "validation_error" }),
    ])
    expect(await readdir(outside)).toEqual([])
    expect(await context.local()).toMatchObject({ "c.md": "3" })
  })

  const listing = (context: Awaited<ReturnType<typeof synced>>, change: (files: RemoteFile[]) => RemoteFile[]) => {
    const list = context.disk.target.list
    return {
      ...context.disk.target,
      list: async (...args: Parameters<FileTarget["list"]>) => {
        const listed = await list(...args)
        return listed && { ...listed, files: change(listed.files) }
      },
    } satisfies FileTarget
  }

  it("refuses remote paths the mirror cannot use, and still takes other deletions as proven", async () => {
    const context = await synced()
    context.disk.remove("c.md")
    const bad = ["../evil.md", "a//b.md", "./x.md", "nul\0.md", "/abs.md"]
    const target = listing(context, (listed) => [
      ...listed,
      ...bad.map((path, n) => ({ ...(listed[0] as RemoteFile), id: `bad-${n}`, path })),
    ])
    const result = await context.sync(undefined, { target })
    expect(result.errors.map((error) => [error.path, error.code])).toEqual(
      bad.map((path) => [path, "invalid_response"]),
    )
    expect(result.trashed).toEqual([{ path: "c.md", side: "local" }])
    expect(existsSync(join(dirname(context.root), "evil.md"))).toBe(false)
  })

  it("takes a synced file moved to a refused path as unknown, never deleted", async () => {
    const context = await synced()
    const target = listing(context, (listed) =>
      listed.map((file) => (file.path === "c.md" ? { ...file, path: "c\0.md" } : file)),
    )
    const result = await context.sync(undefined, { target })
    expect(result.unknown).toEqual([{ path: "c.md", side: "remote", reason: "moved on the disk to a refused path" }])
    expect(result.trashed).toEqual([])
    expect(await context.local()).toMatchObject({ "c.md": "3" })
  })

  it("keeps a backslash in a name, refused only on Windows", async () => {
    const context = await synced()
    context.disk.write("back\\slash.md", "b")
    expect((await context.sync()).downloaded).toEqual(["back\\slash.md"])
    expect(safePath("back\\slash.md", "linux")).toBe(true)
    expect(safePath("back\\slash.md", "win32")).toBe(false)
  })
})

describe("syncFileMirror, a file system without hard links", () => {
  it("creates, trashes and renames by copy, and still never overwrites a file that appeared", async () => {
    const files = { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" }
    const context = setup(files, files)
    await context.sync()
    context.disk.write("new.md", "n")
    context.disk.write("race.md", "remote")
    context.disk.remove("a.md")
    context.disk.move("b.md", "moved/b.md")
    const download = context.disk.target.download
    const target: FileTarget = {
      ...context.disk.target,
      download: async (path, into, ...rest) => {
        if (path.endsWith("race.md")) put(context.root, "race.md", "saved meanwhile")
        await download(path, into, ...rest)
      },
    }
    links.refused = true
    try {
      const result = await context.sync(undefined, { target })
      expect(result).toMatchObject({
        downloaded: ["new.md"],
        trashed: [{ path: "a.md", side: "local" }],
        renamed: [{ from: "b.md", to: "moved/b.md" }],
        errors: [],
      })
      expect(result.conflicts).toEqual([expect.objectContaining({ path: "race.md" })])
    } finally {
      links.refused = false
    }
    expect(await context.local()).toEqual({
      "c.md": "3",
      "d.md": "4",
      "moved/b.md": "2",
      "new.md": "n",
      "race.md": "saved meanwhile",
    })
    expect(readFileSync(join(context.root, ".wirecat-trash", "2026-11-18", "a.md"), "utf8")).toBe("1")
  })
})

describe("syncFileMirror, repin", () => {
  const files = { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" }

  it("ignores repin for a mirror whose roots were not replaced, and keeps its state and deletions", async () => {
    const context = setup(files, files)
    await context.sync()
    rmSync(join(context.root, "a.md"))
    const result = await context.sync(undefined, { repin: true })
    expect(result).toMatchObject({ trashed: [{ path: "a.md", side: "remote" }], errors: [] })
    expect(context.disk.trash.map((item) => item.path)).toEqual(["a.md"])
    expect(Object.keys(context.port.read().entries)).toEqual(["b.md", "c.md", "d.md"])
    expect(context.port.read().rootId).toBe("root-1")
  })

  it("still blocks an empty local folder with repin, whether or not it is another folder", async () => {
    for (const change of ["emptied", "replaced"] as const) {
      const context = setup(files, files)
      await context.sync()
      if (change === "emptied") for (const name of Object.keys(files)) rmSync(join(context.root, name))
      else {
        renameSync(context.root, `${context.root}-old`)
        mkdirSync(context.root)
      }
      const result = await context.sync(undefined, { repin: true })
      expect(result.errors).toEqual([expect.objectContaining({ path: ".", code: "validation_error" })])
      expect(context.disk.calls).toEqual([])
      expect(await context.local()).toEqual({})
      expect(Object.keys(context.port.read().entries)).toEqual(Object.keys(files))
    }
  })

  it("settles nothing with keep in a repin run: different content stays a conflict", async () => {
    const context = setup(files, files)
    await context.sync()
    renameSync(context.root, `${context.root}-old`)
    mkdirSync(context.root)
    for (const [name, content] of Object.entries(files)) put(context.root, name, content)
    put(context.root, "d.md", "4, other")
    for (const keep of ["local", "remote", "both"] as const) {
      const result = await context.sync(keep, { repin: true, dryRun: true })
      expect(result.plan).toEqual(expect.arrayContaining([{ kind: "conflict", path: "d.md" }]))
    }
    const result = await context.sync("local", { repin: true })
    expect(result.conflicts).toEqual([expect.objectContaining({ path: "d.md" })])
    expect(await context.disk.files()).toEqual(files)
    expect(await context.local()).toMatchObject({ "d.md": "4, other" })
  })

  it("records a replaced remote folder again only when asked, deleting nothing in that run", async () => {
    const context = setup(files, files)
    await context.sync()
    context.disk.replaceRoot()
    rmSync(join(context.root, "a.md"))
    const blocked = await context.sync()
    expect(blocked.errors).toEqual([
      expect.objectContaining({
        path: ".",
        code: "confirmation_required",
        message: expect.stringContaining("--repin"),
      }),
    ])
    const named = await context.sync(undefined, { hints: { repin: "mirrors repin" } })
    expect(named.errors[0]?.message).toContain("sync again with mirrors repin to record it")
    const repinned = await context.sync(undefined, { repin: true })
    expect(repinned).toMatchObject({ downloaded: ["a.md"], adopted: ["b.md", "c.md", "d.md"], trashed: [], errors: [] })
    expect(context.disk.trash).toEqual([])
    expect(context.port.read().rootId).toBe("root-2")
    expect(await context.sync()).toMatchObject({ unchanged: 4, errors: [], unknown: [] })
  })

  it("records a replaced local folder again, as a first sync", async () => {
    const context = setup(files, files)
    await context.sync()
    renameSync(context.root, `${context.root}-old`)
    mkdirSync(context.root)
    for (const name of ["b.md", "c.md"]) put(context.root, name, files[name as "b.md"])
    put(context.root, "d.md", "4, other")
    expect((await context.sync()).errors).toEqual([expect.objectContaining({ code: "confirmation_required" })])
    expect(await context.sync(undefined, { repin: true, dryRun: true })).toMatchObject({
      plan: [
        { kind: "download", path: "a.md" },
        { kind: "adopt", path: "b.md" },
        { kind: "adopt", path: "c.md" },
        { kind: "conflict", path: "d.md" },
      ],
    })
    const repinned = await context.sync(undefined, { repin: true })
    expect(repinned).toMatchObject({ downloaded: ["a.md"], trashed: [], errors: [] })
    expect(repinned.conflicts).toEqual([expect.objectContaining({ path: "d.md" })])
    expect(context.disk.writes().filter((call) => call.op !== "download")).toEqual([])
    expect(await context.disk.files()).toEqual(files)
    expect(await context.sync()).toMatchObject({ unchanged: 3, errors: [], unknown: [] })
  })
})

describe("syncFileMirror, a download cut off by a crash", () => {
  it("never sends or overwrites a partial file, and downloads again once it is moved away", async () => {
    const context = setup({}, { "a.md": "full content" })
    const state = context.port.read()
    state.pending["a.md"] = { op: "download", operationId: "op-cut" }
    context.port.save(state)
    put(context.root, "a.md", "full")
    for (const keep of [undefined, "local", "remote", "both"] as const) {
      const result = await context.sync(keep)
      expect(result.conflicts).toEqual([
        expect.objectContaining({ path: "a.md", reason: expect.stringContaining("cut off") }),
      ])
    }
    expect(context.disk.writes().filter((call) => call.op !== "download")).toEqual([])
    expect(await context.local()).toEqual({ "a.md": "full" })
    expect(context.port.read().pending["a.md"]).toBeDefined()
    rmSync(join(context.root, "a.md"))
    expect(await context.sync()).toMatchObject({ downloaded: ["a.md"], conflicts: [] })
    expect(context.port.read().pending).toEqual({})
  })
})

describe("syncFileMirror, a download that replaced a file", () => {
  it("is never taken as cut off: a replacement is renamed into place whole", async () => {
    const context = setup({ "a.md": "1" }, { "a.md": "1" })
    await context.sync()
    put(context.root, "a.md", "mine")
    context.disk.write("a.md", "theirs")
    const state = context.port.read()
    state.pending["a.md"] = { op: "download", operationId: "op-over", created: false }
    context.port.save(state)
    expect((await context.sync()).conflicts).toEqual([
      expect.objectContaining({ path: "a.md", reason: "changed on both sides" }),
    ])
    expect(await context.sync("local")).toMatchObject({ uploaded: ["a.md"], conflicts: [] })
  })
})

describe("syncFileMirrors and restoreFileVersion with acquireLock's lock", () => {
  it("check held() before writing and refuse once the lock is lost", async () => {
    const context = setup({ "a.md": "1" })
    let mine = true
    const lock = { held: vi.fn(async () => mine), release: vi.fn(async () => {}) }
    const { root: _, folder: __, state: ___, assertHeld: ____, ...rest } = context.options()
    const run = () =>
      syncFileMirrors({
        ...rest,
        mirrors: [context.mirror],
        stateOf: () => context.port,
        versionsOf: () => context.versions,
        lock: async () => lock,
      })
    expect((await run()).items[0]).toMatchObject({ uploaded: ["a.md"] })
    expect(lock.held).toHaveBeenCalled()
    mine = false
    put(context.root, "a.md", "2")
    await expect(run()).rejects.toMatchObject({ details: { reason: "profile.busy" } })
    expect(await context.disk.files()).toEqual({ "a.md": "1" })
    expect(lock.release).toHaveBeenCalledTimes(2)
    await expect(
      restoreFileVersion(context.root, "a.md", hashes("1").sha256, context.versions, async () => lock),
    ).rejects.toMatchObject({ details: { reason: "profile.busy" } })
  })
})

describe("skippedName in the package index", () => {
  it("lets a target skip what the mirror skips while it lists", () => {
    expect([".git", "node_modules", "~$draft.docx", "a.md.swp", "a.md"].map(skippedName)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
  })
})

describe("placeNew without hard links", () => {
  it("copies with the source's mode and never touches a file already there", async () => {
    const dir = temp("file-mirror-place-")
    const from = join(dir, "from")
    writeFileSync(from, "new")
    chmodSync(from, 0o640)
    put(dir, "taken", "keep me")
    links.refused = true
    try {
      await expect(placeNew(from, join(dir, "taken"))).rejects.toMatchObject({ code: "EEXIST" })
      await placeNew(from, join(dir, "free"))
    } finally {
      links.refused = false
    }
    expect(readFileSync(join(dir, "taken"), "utf8")).toBe("keep me")
    expect(readFileSync(join(dir, "free"), "utf8")).toBe("new")
    expect(statSync(join(dir, "free")).mode & 0o777).toBe(0o640)
  })
})

describe("fileVersions.prune", () => {
  it("skips an object that vanished while it ran", async () => {
    const dir = temp("file-mirror-versions-")
    let clock = TODAY
    const versions = fileVersions(dir, () => clock)
    const file = join(temp("file-mirror-versions-src-"), "x")
    writeFileSync(file, "x")
    await versions.keep(file)
    clock += 31 * 24 * 60 * 60 * 1000
    const object = join(dir, "objects", hashes("x").sha256)
    vanished.add(object)
    try {
      await expect(versions.prune()).resolves.toBeUndefined()
    } finally {
      vanished.delete(object)
    }
    expect(existsSync(object)).toBe(true)
  })
})
