import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type * as fs from "node:fs"
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildSync } from "esbuild"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppIdentity } from "../cli/app.js"
import { locationVariables } from "./units.js"
import { migrateToWirecatFolder } from "./wirecat-folder.js"

const disk = vi.hoisted(() => ({ crossDevice: false, corruptCopy: false }))

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>()
  const exdev = () => Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" })
  const across = (from: unknown, to: unknown) => disk.crossDevice && dirname(String(from)) !== dirname(String(to))
  return {
    ...real,
    linkSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (across(from, to)) throw exdev()
      return real.linkSync(from, to)
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (across(from, to)) throw exdev()
      return real.renameSync(from, to)
    },
    copyFileSync: (from: fs.PathLike, to: fs.PathLike, mode?: number) => {
      real.copyFileSync(from, to, mode)
      if (disk.corruptCopy) real.appendFileSync(to, "!")
    },
  }
})

const app = { command: "tg", appName: "tg-cli", envPrefix: "TG" }
const SIBLINGS = ["wirecat.db-wal", "wirecat.db-shm", "wirecat.db.backup-1", "wirecat.db.before-restore-2"]

const home = () => {
  const HOME = mkdtempSync(join(tmpdir(), "wirecat-safe-"))
  const old = join(HOME, ".local/share/cli-messaging")
  const next = join(HOME, ".local/share/WireCat")
  const oldModels = join(HOME, ".cache/cli-common/models")
  const seed = (dir: string, file: string, text = "x") => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8")
  const warnings: string[] = []
  const env: NodeJS.ProcessEnv = { HOME }
  const run = (options: Parameters<typeof migrateToWirecatFolder>[1] = {}) =>
    migrateToWirecatFolder(app, {
      env,
      platform: "linux",
      holders: () => [],
      warn: (l) => warnings.push(l),
      ...options,
    })
  return { HOME, old, next, oldModels, seed, read, warnings, env, run }
}

beforeEach(() => {
  disk.crossDevice = false
  disk.corruptCopy = false
})

describe("moving the store never overwrites or deletes", () => {
  it.each(SIBLINGS)("stops on a different %s already in the WireCat folder, and changes nothing", (name) => {
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    for (const sibling of SIBLINGS) seed(old, sibling, `old ${sibling}`)
    seed(next, name, "new")

    expect(run).toThrow(`${join(old, name)} and ${join(next, name)}`)

    expect(read(old, "wirecat.db")).toBe("rows")
    for (const sibling of SIBLINGS) expect(read(old, sibling)).toBe(`old ${sibling}`)
    expect(read(next, name)).toBe("new")
    expect(readdirSync(next).filter((entry) => !entry.startsWith("."))).toEqual([name])
  })

  it("copies across file systems, checks the copy, and only then removes the source", () => {
    disk.crossDevice = true
    const { old, next, oldModels, seed, read, warnings, run } = home()
    seed(old, "wirecat.db", "rows")
    for (const sibling of SIBLINGS) seed(old, sibling, sibling)
    seed(oldModels, "audio/m.bin", "model")

    run()

    expect(read(next, "wirecat.db")).toBe("rows")
    for (const sibling of SIBLINGS) expect(read(next, sibling)).toBe(sibling)
    expect(read(next, "models/audio/m.bin")).toBe("model")
    expect(readdirSync(old)).toEqual([])
    expect(existsSync(oldModels)).toBe(false)
    expect(readdirSync(next).some((entry) => entry.includes(".partial-"))).toBe(false)
    expect(warnings).toEqual([])
  })

  it("keeps the source when a cross-device copy comes out different", () => {
    disk.crossDevice = true
    disk.corruptCopy = true
    const { old, next, seed, read, warnings, env, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(old, "wirecat.db-wal", "wal")

    run()

    expect(read(old, "wirecat.db")).toBe("rows")
    expect(read(old, "wirecat.db-wal")).toBe("wal")
    expect(readdirSync(next).filter((entry) => !entry.startsWith("."))).toEqual([])
    expect(env.MESSAGING_STORE).toBe(join(old, "wirecat.db"))
    expect(warnings).toEqual([expect.stringMatching(/came out different/)])
  })

  it("stops on a different destination across file systems too", () => {
    disk.crossDevice = true
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(old, "wirecat.db-wal", "old wal")
    seed(next, "wirecat.db-wal", "new wal")

    expect(run).toThrow(/two different copies of the store/)

    expect(read(old, "wirecat.db")).toBe("rows")
    expect(read(old, "wirecat.db-wal")).toBe("old wal")
    expect(read(next, "wirecat.db-wal")).toBe("new wal")
  })

  it("leaves a wal or shm whose db is gone where it is", () => {
    const { old, next, seed, read, run } = home()
    seed(next, "wirecat.db", "rows")
    seed(old, "wirecat.db-shm", "stale")

    run()

    expect(read(old, "wirecat.db-shm")).toBe("stale")
    expect(existsSync(join(next, "wirecat.db-shm"))).toBe(false)
  })

  it("does nothing on the second run", () => {
    const { old, next, seed, read, warnings, run } = home()
    seed(old, "wirecat.db", "rows")
    run()
    run()

    expect(read(next, "wirecat.db")).toBe("rows")
    expect(warnings).toEqual([])
  })
})

describe("a move cut short finishes on the next start", () => {
  it("drops the old name when both names are the same file", () => {
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    mkdirSync(next, { recursive: true })
    linkSync(join(old, "wirecat.db"), join(next, "wirecat.db"))

    run()

    expect(existsSync(join(old, "wirecat.db"))).toBe(false)
    expect(read(next, "wirecat.db")).toBe("rows")
  })

  it("drops the source when an identical copy already arrived", () => {
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(next, "wirecat.db", "rows")

    run()

    expect(existsSync(join(old, "wirecat.db"))).toBe(false)
    expect(read(next, "wirecat.db")).toBe("rows")
  })

  it("moves the db after its wal already moved", () => {
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(next, "wirecat.db-wal", "wal")

    run()

    expect(read(next, "wirecat.db")).toBe("rows")
    expect(read(next, "wirecat.db-wal")).toBe("wal")
    expect(existsSync(join(old, "wirecat.db"))).toBe(false)
  })

  it("throws away a half-written copy and starts again", () => {
    const { old, next, oldModels, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(next, "wirecat.db.partial-99999", "ro")
    seed(oldModels, "audio/m.bin", "model")
    seed(next, "models.partial-99999/audio/m.bin", "mo")

    run()

    expect(read(next, "wirecat.db")).toBe("rows")
    expect(read(next, "models/audio/m.bin")).toBe("model")
    expect(readdirSync(next).filter((entry) => entry.includes(".partial-"))).toEqual([])
  })
})

describe("one mover at a time", () => {
  it("waits for a live mover, then stops without touching anything", () => {
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(next, ".moving.lock", JSON.stringify({ pid: process.ppid, startedAt: "x" }))

    expect(() => run({ lockWaitMs: 300 })).toThrow(`pid ${process.ppid} is moving the store`)

    expect(read(old, "wirecat.db")).toBe("rows")
    expect(existsSync(join(next, "wirecat.db"))).toBe(false)
  })

  it("takes over the lock of a mover that died", () => {
    const { old, next, seed, read, run } = home()
    seed(old, "wirecat.db", "rows")
    seed(next, ".moving.lock", JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "x" }))

    run({ lockWaitMs: 300 })

    expect(read(next, "wirecat.db")).toBe("rows")
    expect(existsSync(join(next, ".moving.lock"))).toBe(false)
  })

  it("moves the store exactly once when two processes start together", async () => {
    const { HOME, old, next, seed } = home()
    const store = Buffer.alloc(1024 * 1024, "r")
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, "wirecat.db"), store)
    for (let n = 0; n < 3000; n++) seed(old, `wirecat.db.backup-${n}`, `backup ${n}`)
    const bundle = join(mkdtempSync(join(tmpdir(), "wirecat-bundle-")), "move.mjs")
    buildSync({
      entryPoints: [join(import.meta.dirname, "wirecat-folder.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      banner: {
        js: 'import { createRequire as __wirecatRequire } from "node:module"; const require = __wirecatRequire(import.meta.url);',
      },
      logLevel: "silent",
    })
    const script = `import { migrateToWirecatFolder } from ${JSON.stringify(bundle)}
migrateToWirecatFolder({ command: "t", appName: "t-cli", envPrefix: "T" }, { env: { HOME: process.env.HOME }, platform: "linux", holders: () => [] })`
    const start = () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME } })
        let stderr = ""
        child.stderr.on("data", (chunk) => {
          stderr += chunk
        })
        child.on("exit", (code) => resolve({ code, stderr }))
      })

    const results = await Promise.all([start(), start()])

    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ])
    expect(readdirSync(old)).toEqual([])
    const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex")
    expect(hash(readFileSync(join(next, "wirecat.db")))).toBe(hash(store))
    expect(readdirSync(next).filter((entry) => entry.startsWith("wirecat.db.backup-"))).toHaveLength(3000)
    expect(statSync(join(next, "wirecat.db")).nlink).toBe(1)
  }, 30_000)
})

describe("overrides and what this run uses", () => {
  it("keeps a store under MESSAGING_STATE_DIR where it is and uses it, and still moves the models", () => {
    const { HOME, next, oldModels, seed, read, env, run } = home()
    const elsewhere = join(HOME, "elsewhere")
    env.MESSAGING_STATE_DIR = elsewhere
    seed(elsewhere, "wirecat.db", "rows")
    seed(oldModels, "audio/m.bin", "model")

    run()

    expect(env.MESSAGING_STORE).toBe(join(elsewhere, "wirecat.db"))
    expect(read(elsewhere, "wirecat.db")).toBe("rows")
    expect(existsSync(join(next, "wirecat.db"))).toBe(false)
    expect(read(next, "models/audio/m.bin")).toBe("model")
  })

  it("leaves the models where CLI_COMMON_CACHE_DIR put them", () => {
    const { HOME, next, seed, env, run } = home()
    env.CLI_COMMON_CACHE_DIR = join(HOME, "cache")
    seed(join(HOME, "cache/models"), "audio/m.bin", "model")

    run()

    expect(existsSync(join(HOME, "cache/models/audio/m.bin"))).toBe(true)
    expect(existsSync(join(next, "models"))).toBe(false)
  })

  it("keeps the old store while something holds it, says only paths and pids, and never pins it into a unit", () => {
    const { old, seed, warnings, env, run } = home()
    seed(old, "wirecat.db", "message text +79990001122")

    run({ holders: () => ["pid 42 (/x/wirecat.db)"] })

    expect(env.MESSAGING_STORE).toBe(join(old, "wirecat.db"))
    expect(warnings).toEqual([expect.stringMatching(/pid 42/)])
    expect(warnings.join("\n")).not.toMatch(/message text|7999/)
    expect(locationVariables(app as AppIdentity, env)).not.toHaveProperty("MESSAGING_STORE")
  })
})
