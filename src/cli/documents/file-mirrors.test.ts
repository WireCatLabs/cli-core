import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, posix } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { Expect, FileTarget, RemoteFile } from "../../documents.js"
import type { KeyedGuard } from "../../sends/keyed-guard.js"
import { outputFor, provide } from "../context.js"
import { type Body, renderAnswer } from "../envelope.js"
import { hasSharedContract } from "../shared-contracts.js"
import type { FileMirrorWrite } from "./file-mirrors.js"
import { fileMirrorsCommand } from "./index.js"

const FOLDER = "/Notes"
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

/** A remote folder on disk; `rewrite` gives the remote's own form of what it is sent, as Notion does. */
const remoteOf = (rewrite?: (text: string) => string) => {
  const dir = mkdtempSync(join(tmpdir(), "file-mirrors-remote-"))
  const ids = new Map<string, string>()
  const trash: string[] = []
  let next = 0
  const inside = (path: string) => posix.relative(FOLDER, path)
  const describe = (path: string): RemoteFile => {
    const bytes = readFileSync(join(dir, path))
    return {
      path,
      id: ids.get(path) as string,
      size: bytes.length,
      sha256: sha(bytes),
      modifiedAt: "2026-11-23T10:00:00.000Z",
    }
  }
  const check = (path: string, expect: Expect) => {
    const here = existsSync(join(dir, path)) ? describe(path) : undefined
    if ("absent" in expect ? here : here?.sha256 !== expect.sha256)
      throw new CliError("conflict", "the remote file is not as expected")
  }
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
    if (!ids.has(path)) ids.set(path, `r${++next}`)
  }
  const target: FileTarget = {
    identity: async () => "alpha",
    list: async (root) => {
      if (root !== FOLDER) return undefined
      return { rootId: "root", files: [...ids.keys()].sort().map(describe), complete: true }
    },
    exists: async (path) => ids.has(inside(path)),
    download: async (path, into) => writeFileSync(into, readFileSync(join(dir, inside(path))), { flag: "wx" }),
    upload: async (path, from, expect) => {
      const at = inside(path)
      check(at, expect)
      const text = readFileSync(from, "utf8")
      put(at, rewrite ? rewrite(text) : text)
      return describe(at)
    },
    trash: async (path, expect) => {
      const at = inside(path)
      check(at, expect)
      trash.push(at)
      rmSync(join(dir, at))
      ids.delete(at)
    },
    ensureFolder: async (path) => {
      mkdirSync(join(dir, inside(path)), { recursive: true })
    },
    ...(rewrite ? { rewrites: true } : {}),
  }
  return { target, put, trash, read: (path: string) => readFileSync(join(dir, path), "utf8") }
}

const IDENTITY = { command: "ydisk", appName: "ydisk-cli", envPrefix: "YDISK", description: "ydisk", version: "1.0.0" }
const MARK = "0123456789abcdef"

const setup = (rewrite?: (text: string) => string, env?: NodeJS.ProcessEnv) => {
  const home = mkdtempSync(join(tmpdir(), "file-mirrors-home-"))
  const state = mkdtempSync(join(tmpdir(), "file-mirrors-state-"))
  const local = mkdtempSync(join(tmpdir(), "file-mirrors-local-"))
  const remote = remoteOf(rewrite)
  const writes: (FileMirrorWrite & { keys: readonly string[] })[] = []
  const runs = { open: 0 }
  const bodies: Body[] = []
  const guard = { refuse: () => {}, check: () => {}, record: () => {} } as unknown as KeyedGuard
  const keysOf = (write: FileMirrorWrite) =>
    write.side === "remote" ? (write.action === "delete" ? ["files.delete"] : ["files.upload"]) : []
  const program = new Command("host").option("--json").exitOverride()
  const streams = captureStreams()
  provide(program, { streams, env: { HOME: home, ...env }, tty: false, app: IDENTITY })
  program.addCommand(
    fileMirrorsCommand({
      identity: IDENTITY,
      service: "Yandex Disk",
      remote: "disk",
      root: {
        place: "Yandex Disk folder",
        description: "the Disk folder, by its path",
        examples: ["/Notes ./notes", "/ ~/YandexDisk"],
      },
      output: (command, body) => {
        bodies.push(body)
        if (env !== undefined) renderAnswer(command, outputFor(command), body)
      },
      profile: () => "personal",
      stateDir: () => state,
      keepForDays: () => 365,
      connect: async (_command, body) => {
        runs.open += 1
        try {
          return await body({
            target: remote.target,
            root: async (input) => {
              if (input !== FOLDER) throw new CliError("not_found", `${input} is not on the Disk`)
              return { folder: FOLDER, rootId: "root" }
            },
          })
        } finally {
          runs.open -= 1
        }
      },
      writeGuard: () => guard,
      keysOf: (write) => {
        const keys = keysOf(write)
        writes.push({ ...write, keys })
        return keys
      },
    }),
  )
  const run = async (...args: string[]) => {
    await program.parseAsync(["mirrors", ...args], { from: "user" })
    return bodies.at(-1) as Body & { item?: Record<string, unknown>; items?: Record<string, unknown>[] }
  }
  const add = async () => (await run("add", FOLDER, local)).item?.id as string
  return { home, state, local, remote, writes, runs, run, add, streams, program }
}

describe("fileMirrorsCommand", () => {
  it("is cli-core's own mirrors group", () => {
    const { program } = setup()
    const mirrors = program.commands.find((command) => command.name() === "mirrors")
    expect(mirrors && hasSharedContract(mirrors)).toBe(true)
  })

  it("marks the files a preview names for a scheduled agent, and leaves the mirror's own folder as it is", async () => {
    const preview = async (env: NodeJS.ProcessEnv) => {
      const { local, remote, run, add, streams } = setup(undefined, env)
      remote.put("theirs.md", "theirs\n")
      await add()
      streams.stdout.length = 0
      await run("preview", "--json")
      return { local, item: JSON.parse(streams.stdout.join("")).items[0] }
    }
    const locked = await preview({ YDISK_READ_ONLY: "1", YDISK_UNTRUSTED_MARK: MARK })
    expect(locked.item.plan).toEqual([
      {
        kind: "download",
        path: expect.stringMatching(
          new RegExp(`^⟦untrusted:${MARK} source=plan.path [^⟧]*⟧theirs.md⟦/untrusted:${MARK}⟧$`),
        ),
      },
    ])
    expect(locked.item.path).toBe(locked.local)
    expect((await preview({})).item.plan).toEqual([{ kind: "download", path: "theirs.md" }])
  })

  it("adds a mirror, syncs both ways inside the app's run and keeps the pair on disk as ydisk did", async () => {
    const { state, local, remote, run, add, runs } = setup()
    writeFileSync(join(local, "mine.md"), "mine\n")
    remote.put("theirs.md", "theirs\n")
    const id = await add()
    expect((await run("list")).items).toEqual([{ id, path: local, folder: FOLDER, ignore: [] }])
    expect(JSON.parse(readFileSync(join(state, "mirrors.json"), "utf8"))).toEqual([
      { id, path: local, folder: FOLDER, account: "alpha" },
    ])
    const synced = (await run("sync")).items?.[0]
    expect(synced).toMatchObject({ id, uploaded: ["mine.md"], downloaded: ["theirs.md"] })
    expect(remote.read("mine.md")).toBe("mine\n")
    expect(readFileSync(join(local, "theirs.md"), "utf8")).toBe("theirs\n")
    expect(existsSync(join(state, "mirrors", `${id}.json`))).toBe(true)
    expect(runs.open).toBe(0)
  })

  it("sends a local deletion to the remote's trash, checking the app's delete key", async () => {
    const { local, remote, run, add, writes } = setup()
    writeFileSync(join(local, "old.md"), "old\n")
    writeFileSync(join(local, "stays.md"), "stays\n")
    await add()
    await run("sync")
    rmSync(join(local, "old.md"))
    expect((await run("status")).items?.[0]).toMatchObject({ delete: 1 })
    expect((await run("sync")).items?.[0]).toMatchObject({ trashed: [{ path: "old.md", side: "remote" }] })
    expect(remote.trash).toEqual(["old.md"])
    expect(writes).toContainEqual({ action: "delete", side: "remote", keys: ["files.delete"] })
  })

  it("takes a rewriting remote's form back into the local file as a local update, with the keys the app gives it", async () => {
    const { local, remote, run, add, writes } = setup((text) => `${text.trimEnd()}\n`)
    writeFileSync(join(local, "page.md"), "page\n\n\n")
    const id = await add()
    await run("sync")
    expect(remote.read("page.md")).toBe("page\n")
    expect(readFileSync(join(local, "page.md"), "utf8")).toBe("page\n")
    expect(writes).toContainEqual({ action: "update", side: "local", keys: [] })
    const events = (await run("versions", "list", id, "page.md")).items
    expect(events?.map((event) => event.event)).toContain("created")
  })

  it("leaves a conflict listed for mirrors conflicts and settles it there", async () => {
    const { local, remote, run, add } = setup()
    writeFileSync(join(local, "plan.md"), "a\n")
    const id = await add()
    await run("sync")
    writeFileSync(join(local, "plan.md"), "mine\n")
    remote.put("plan.md", "theirs\n")
    await expect(run("sync")).rejects.toMatchObject({ details: { reason: "mirror.partial" } })
    expect((await run("conflicts", "list")).items).toEqual([expect.objectContaining({ id, path: "plan.md" })])
    expect((await run("conflicts", "resolve", id, "plan.md", "--keep", "disk")).item).toMatchObject({
      resolution: "disk",
    })
    expect(readFileSync(join(local, "plan.md"), "utf8")).toBe("theirs\n")
  })

  it("never mirrors the home folder", async () => {
    const { home, run } = setup()
    await expect(run("add", FOLDER, home)).rejects.toMatchObject({ details: { reason: "mirror.not-folder" } })
  })

  it("changes what a mirror ignores, and forgets the pair on remove without touching either side", async () => {
    const { local, state, run, add } = setup()
    writeFileSync(join(local, "keep.md"), "keep\n")
    const id = await add()
    expect((await run("update", id, "--ignore", "Photos")).item).toEqual({ id, ignore: ["Photos"] })
    await run("sync")
    expect((await run("remove", id)).item).toEqual({ id, removed: true })
    expect((await run("list")).items).toEqual([])
    expect(existsSync(join(state, "mirrors", `${id}.json`))).toBe(false)
    expect(existsSync(join(local, "keep.md"))).toBe(true)
  })

  it("takes --allow-deletions only with one mirror's id", async () => {
    const { run, add } = setup()
    await add()
    await expect(run("sync", "--allow-deletions", "0")).rejects.toMatchObject({
      details: { param: "--allow-deletions" },
    })
  })
})
