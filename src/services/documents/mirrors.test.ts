import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { DocumentTarget } from "../../documents/push-model.js"
import { conflictReport, fileMirrorState, type Mirror, mirrorId, mirrorStatus, syncMirrors } from "./mirrors.js"

type Snapshot = { kind: "doc"; text: string }

const folder = (files: Record<string, string> = {}) => {
  const root = mkdtempSync("/var/tmp/document-mirrors-")
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
  return root
}

const mirrorOf = (path: string, remoteFolder = "folder-1"): Mirror => ({
  id: mirrorId(path, remoteFolder),
  path,
  folder: remoteFolder,
})

// One remote Doc per local file, whole text as one block: a text changed on both sides is a conflict.
const fakeTarget = () => {
  const remote = new Map<string, string>()
  let ids = 0
  const target: DocumentTarget<Snapshot> = {
    identity: async () => "alpha",
    kindOf: (path) => (path.endsWith(".md") ? "doc" : undefined),
    ensureFolder: async () => "folder-1",
    findByOrigin: async () => undefined,
    create: async ({ file }) => {
      const id = `file-${++ids}`
      const text = readFileSync(file.absolute, "utf8")
      remote.set(id, text)
      return { id, url: `https://example.invalid/${id}`, snapshot: { kind: "doc", text } }
    },
    prepare: async ({ id, file, recorded }) => {
      const now = remote.get(id) ?? ""
      const local = readFileSync(file.absolute, "utf8")
      const pushed = (text: string) => ({
        id,
        url: `https://example.invalid/${id}`,
        snapshot: { kind: "doc" as const, text },
      })
      if (now === local) return { unchanged: pushed(local) }
      if (now !== recorded.text) return { conflict: "both", parts: [{ base: recorded.text, local, remote: now }] }
      return {
        remote: true,
        write: async () => {
          remote.set(id, local)
          return pushed(local)
        },
      }
    },
  }
  return { target, remote }
}

const options = (target: DocumentTarget<Snapshot>, mirrors: Mirror[], stateDir: string, lock = fakeLock()) => ({
  mirrors,
  target,
  stateOf: (mirror: Mirror) => fileMirrorState<Snapshot>(stateDir, mirror, "alpha", ["doc"]),
  principal: "alpha",
  guard: <T>(_attempt: unknown, act: () => Promise<T>) => act(),
  operationId: () => "op",
  errorOf: (error: unknown) => (isCliError(error) ? error : new CliError("provider_error", String(error))),
  lock: async () => lock,
  remote: "google",
})

const fakeLock = () => ({ assertHeld: vi.fn(), release: vi.fn() })

describe("fileMirrorState", () => {
  it("starts empty, saves 0600 in a 0700 folder and reads its own file back", () => {
    const dir = join(folder(), "mirrors")
    const mirror = mirrorOf("/notes")
    const port = fileMirrorState<Snapshot>(dir, mirror, "alpha", ["doc"])
    const state = port.read()
    expect(state).toMatchObject({ version: 1, principal: "alpha", root: "/notes", target: "folder-1", entries: {} })
    state.entries["a.md"] = {
      id: "file-1",
      url: "u",
      kind: "doc",
      hash: "h",
      snapshot: { kind: "doc", text: "x" },
      pushedAt: "t",
    }
    port.save(state)
    expect(statSync(join(dir, `${mirror.id}.json`)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(port.read().entries["a.md"]?.snapshot).toEqual({ kind: "doc", text: "x" })
  })

  it("refuses an unreadable or invalid file instead of starting over", () => {
    const dir = folder()
    const mirror = mirrorOf("/notes")
    const port = fileMirrorState<Snapshot>(dir, mirror, "alpha", ["doc"])
    writeFileSync(join(dir, `${mirror.id}.json`), "{")
    expect(() => port.read()).toThrow(expect.objectContaining({ details: { reason: "state.invalid" } }))
    writeFileSync(join(dir, `${mirror.id}.json`), JSON.stringify({ version: 2 }))
    expect(() => port.read()).toThrow(expect.objectContaining({ details: { reason: "state.invalid" } }))
  })

  it("keeps the mirror id drive 0.21–0.24 wrote", () => {
    expect(mirrorId("/home/a/notes", "FOLDER_ID")).toBe("0f16ea64")
  })
})

describe("syncMirrors", () => {
  it("syncs every mirror, reports a conflict as one partial issue and releases the lock", async () => {
    const stateDir = folder()
    const clean = mirrorOf(folder({ "a.md": "one" }), "folder-1")
    const torn = mirrorOf(folder({ "b.md": "two" }), "folder-2")
    const { target, remote } = fakeTarget()
    const lock = fakeLock()
    await syncMirrors(options(target, [clean, torn], stateDir, lock))

    writeFileSync(join(torn.path, "b.md"), "two, local")
    remote.set("file-2", "two, google")
    const result = await syncMirrors(options(target, [clean, torn], stateDir, lock))

    expect(result.items.map((item) => [item.id, item.unchanged, item.conflicts.length])).toEqual([
      [clean.id, 1, 0],
      [torn.id, 0, 1],
    ])
    expect(result.items[1]?.conflicts[0]).toMatchObject({
      path: "b.md",
      parts: [{ last_sync: "two", local: "two, local", google: "two, google" }],
    })
    expect(result.issues).toEqual([{ code: "provider_error", reason: "mirror.partial", source: `mirror ${torn.id}` }])
    expect(lock.release).toHaveBeenCalledTimes(2)
  })

  it("releases the lock when a mirror fails outright", async () => {
    const { target } = fakeTarget()
    const lock = fakeLock()
    const wrong = { ...target, identity: async () => "beta" }
    await expect(syncMirrors(options(wrong, [mirrorOf(folder())], folder(), lock))).rejects.toMatchObject({
      details: { reason: "profile.wrong-account" },
    })
    expect(lock.release).toHaveBeenCalledOnce()
  })
})

describe("mirrorStatus", () => {
  it("lists what the next sync would create without asking the remote", async () => {
    const root = folder({ "a.md": "one", "b.txt": "skip" })
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "sub", "c.md"), "three")
    const mirror = mirrorOf(root)
    const [item] = await mirrorStatus([mirror], fakeTarget().target.kindOf, (one) =>
      fileMirrorState<Snapshot>(folder(), one, "alpha", ["doc"]),
    )
    expect(item).toMatchObject({ id: mirror.id, create: ["a.md", "sub/c.md"], update: [], remote_checked: false })
  })
})

describe("conflictReport", () => {
  it("names the remote side in the field names", () => {
    expect(
      conflictReport(
        { path: "a.md", url: "u", reason: "both", remoteChangedAt: "t1", remoteChangedBy: "Ann", localChangedAt: "t0" },
        "google",
      ),
    ).toEqual({
      path: "a.md",
      url: "u",
      reason: "both",
      local_changed_at: "t0",
      google_changed_at: "t1",
      google_changed_by: "Ann",
    })
  })
})
