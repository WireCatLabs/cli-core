import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { DocumentTarget, PushEntry, PushState } from "../../documents/push-model.js"

type PushEntryOf = PushEntry<string>

import { type PushOptions, pushDocuments } from "./push.js"

interface Remote {
  name: string
  parent: string
  origin: string
  text: string
  editedRemotely?: boolean
}

const setup = () => {
  const root = mkdtempSync("/var/tmp/document-push-")
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const remote = new Map<string, Remote>()
  const folders = new Map<string, string>()
  let ids = 0
  let failCreateAfterWrite = false
  const target: DocumentTarget<string> = {
    identity: async () => "alpha",
    kindOf: (path) => (path.endsWith(".md") ? "doc" : path.endsWith(".csv") ? "sheet" : undefined),
    ensureFolder: vi.fn(async ({ origin }) => {
      const known = folders.get(origin)
      if (known) return known
      const id = `folder-${++ids}`
      folders.set(origin, id)
      return id
    }),
    findByOrigin: vi.fn(async (origin) => {
      for (const [id, file] of remote)
        if (file.origin === origin) return { id, url: `https://example.invalid/${id}`, snapshot: file.text }
      return undefined
    }),
    create: vi.fn(async ({ file, name, parent, origin }) => {
      const id = `file-${++ids}`
      const text = readFileSync(file.absolute, "utf8")
      remote.set(id, { name, parent, origin, text })
      if (failCreateAfterWrite) {
        failCreateAfterWrite = false
        throw new Error("connection dropped after the provider wrote")
      }
      return { id, url: `https://example.invalid/${id}`, snapshot: text }
    }),
    prepare: vi.fn(async ({ id, file, recorded, force }) => {
      const found = remote.get(id)
      if (!found) return { missing: true as const }
      if (found.text !== recorded && !force) return { conflict: "changed remotely since the last push" }
      const text = readFileSync(file.absolute, "utf8")
      if (text === found.text) return { unchanged: { id, url: `https://example.invalid/${id}`, snapshot: text } }
      return {
        write: async () => {
          found.text = text
          return { id, url: `https://example.invalid/${id}`, snapshot: text }
        },
      }
    }),
  }
  let state: PushState<string> = {
    version: 1,
    principal: "alpha",
    root,
    target: "mirror-root",
    folders: {},
    entries: {},
    pending: {},
  }
  let operations = 0
  const guarded: string[] = []
  const options = (extra: Partial<PushOptions<string>> = {}): PushOptions<string> => ({
    root,
    folder: "mirror-root",
    target,
    principal: "alpha",
    state: { read: () => structuredClone(state), save: (next) => (state = structuredClone(next)) },
    guard: async (attempt, act) => {
      guarded.push(`${attempt.action}:${attempt.path}`)
      return act()
    },
    operationId: () => `op-${++operations}`,
    errorOf: (error) => (isCliError(error) ? error : new CliError("provider_error", "synthetic provider failure")),
    assertHeld: () => {},
    now: () => Date.parse("2026-10-22T10:00:00Z"),
    ...extra,
  })
  return {
    root,
    write,
    remote,
    target,
    guarded,
    options,
    state: () => state,
    failNextCreate: () => (failCreateAfterWrite = true),
  }
}

describe("pushDocuments", () => {
  it("creates new files in matching folders, then skips them until they change", async () => {
    const t = setup()
    t.write("notes.md", "# a")
    t.write("data/table.csv", "a,b")
    t.write("photo.png", "x")
    t.write(".hidden.md", "secret")
    const first = await pushDocuments(t.options())
    expect(first).toMatchObject({ created: ["data/table.csv", "notes.md"], updated: [], unchanged: 0, unsupported: 1 })
    expect(t.guarded).toEqual(["folder:data", "create:data/table.csv", "create:notes.md"])
    expect([...t.remote.values()].map((file) => [file.name, file.parent])).toEqual([
      ["table.csv", "folder-1"],
      ["notes.md", "mirror-root"],
    ])

    const second = await pushDocuments(t.options())
    expect(second).toMatchObject({ created: [], updated: [], unchanged: 2 })
    t.write("notes.md", "# b")
    const third = await pushDocuments(t.options())
    expect(third).toMatchObject({ updated: ["notes.md"], unchanged: 1 })
  })

  it("stops on a remote edit and overwrites it only when forced", async () => {
    const t = setup()
    t.write("notes.md", "# a")
    await pushDocuments(t.options())
    const [id, file] = [...t.remote.entries()][0] as [string, Remote]
    file.text = "# edited in the provider"
    t.write("notes.md", "# b")
    const stopped = await pushDocuments(t.options())
    expect(t.guarded.filter((step) => step.startsWith("update"))).toEqual([])
    expect(stopped.conflicts).toEqual([
      { path: "notes.md", url: `https://example.invalid/${id}`, reason: "changed remotely since the last push" },
    ])
    expect(file.text).toBe("# edited in the provider")
    await pushDocuments(t.options({ force: true }))
    expect(file.text).toBe("# b")
  })

  it("finds a file created before a crash instead of creating it twice", async () => {
    const t = setup()
    t.write("notes.md", "# a")
    t.failNextCreate()
    const crashed = await pushDocuments(t.options())
    expect(crashed.errors).toHaveLength(1)
    expect(Object.keys(t.state().pending)).toEqual(["notes.md"])
    const resumed = await pushDocuments(t.options())
    expect(t.remote.size).toBe(1)
    expect(resumed).toMatchObject({ created: [], updated: [], unchanged: 1 })
    expect(t.state().pending).toEqual({})
  })

  it("reports orphans and files deleted remotely, and never deletes", async () => {
    const t = setup()
    t.write("a.md", "a")
    t.write("b.md", "b")
    await pushDocuments(t.options())
    const ids = [...t.remote.keys()]
    t.remote.delete(ids[1] as string)
    rmSync(join(t.root, "a.md"))
    t.write("b.md", "b2")
    const result = await pushDocuments(t.options())
    expect(result.orphans).toEqual([{ path: "a.md", url: `https://example.invalid/${ids[0]}` }])
    expect(result.missing).toEqual(["b.md"])
    expect(t.remote.size).toBe(1)
  })

  it("records a change that alters nothing remotely without a write", async () => {
    const t = setup()
    t.write("a.md", "a")
    await pushDocuments(t.options())
    t.write("a.md", "b")
    const [, file] = [...t.remote.entries()][0] as [string, Remote]
    file.text = "b"
    t.state().entries["a.md"] = { ...(t.state().entries["a.md"] as PushEntryOf), snapshot: "b" }
    const result = await pushDocuments(t.options())
    expect(result).toMatchObject({ updated: [], unchanged: 1 })
    expect(t.guarded.filter((step) => step.startsWith("update"))).toEqual([])
  })

  it("plans without writing on a dry run", async () => {
    const t = setup()
    t.write("a.md", "a")
    const result = await pushDocuments(t.options({ dryRun: true }))
    expect(result.plan).toEqual({ create: ["a.md"], update: [], orphans: [] })
    expect(t.remote.size).toBe(0)
    expect(t.guarded).toEqual([])
  })

  it("does not follow a symbolic link out of the folder", async () => {
    const t = setup()
    const outside = mkdtempSync("/var/tmp/document-push-outside-")
    writeFileSync(join(outside, "private.md"), "secret")
    symlinkSync(outside, join(t.root, "linked"))
    symlinkSync(join(outside, "private.md"), join(t.root, "private.md"))
    const result = await pushDocuments(t.options())
    expect(result.created).toEqual([])
  })

  it("refuses state that belongs to another mirror or account", async () => {
    const t = setup()
    await expect(pushDocuments(t.options({ folder: "other-root" }))).rejects.toMatchObject({
      code: "configuration_error",
    })
    await expect(pushDocuments(t.options({ principal: "beta" }))).rejects.toMatchObject({
      code: "authentication_error",
    })
  })

  it("stops between files when cancelled", async () => {
    const t = setup()
    t.write("a.md", "a")
    t.write("b.md", "b")
    const controller = new AbortController()
    const options = t.options({ signal: controller.signal })
    const guard = options.guard
    options.guard = async (attempt, act) => {
      const result = await guard(attempt, act)
      controller.abort()
      return result
    }
    const result = await pushDocuments(options)
    expect(result).toMatchObject({ created: ["a.md"], stopped: true })
  })
})
