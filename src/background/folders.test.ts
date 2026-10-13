import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { migrateFolders } from "./folders.js"

const app = { command: "tg", appName: "tg-cli", envPrefix: "TG" }
const GONE = 2 ** 22 + 12345

const mac = () => {
  const HOME = mkdtempSync(join(tmpdir(), "folders-"))
  const library = (folder: string, name: string) => join(HOME, "Library", folder, name)
  const seed = (dir: string, file: string, text = "x") => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const warnings: string[] = []
  const env: NodeJS.ProcessEnv = { HOME }
  const run = (lsof = () => [] as string[]) =>
    migrateFolders(app, { env, platform: "darwin", lsof, warn: (line) => warnings.push(line) })
  return { HOME, library, seed, warnings, env, run }
}

describe("migrateFolders", () => {
  it("moves the CLI's folders, the shared store and the shared cache", () => {
    const { HOME, library, seed, run } = mac()
    seed(library("Preferences", "tg-cli"), "config.json")
    seed(library("Application Support", "cli-messaging"), "wirecat.db", "rows")
    seed(join(library("Caches", "cli-common"), "models"), "model.bin")

    run()

    expect(existsSync(join(HOME, ".config/tg-cli/config.json"))).toBe(true)
    expect(readFileSync(join(HOME, ".local/share/WireCat/wirecat.db"), "utf8")).toBe("rows")
    expect(existsSync(join(HOME, ".local/share/WireCat/models/model.bin"))).toBe(true)
  })

  it("points an installed serve agent's log at the new state folder", () => {
    const { HOME, library, seed, run } = mac()
    const old = library("Application Support", "tg-cli")
    seed(join(old, "serve"), "default.log")
    seed(
      join(HOME, "Library", "LaunchAgents"),
      "tg-cli.serve.default.plist",
      `<string>${old}/serve/default.log</string>`,
    )

    run()

    expect(readFileSync(join(HOME, "Library/LaunchAgents/tg-cli.serve.default.plist"), "utf8")).toBe(
      `<string>${join(HOME, ".local/share/tg-cli")}/serve/default.log</string>`,
    )
  })

  it("keeps a running serve's folder, warns, and points this run at the old folders", () => {
    const { HOME, library, seed, warnings, env, run } = mac()
    const old = library("Application Support", "tg-cli")
    seed(join(old, "serve"), "default.lock", JSON.stringify({ pid: process.ppid, startedAt: "2026-10-11T12:00:00Z" }))

    run()

    expect(existsSync(join(old, "serve", "default.lock"))).toBe(true)
    expect(existsSync(join(HOME, ".local/share/tg-cli"))).toBe(false)
    expect(env.TG_STATE_DIR).toBe(old)
    expect(warnings).toEqual([expect.stringMatching(/^tg: kept tg-cli's files in ~\/Library for now — .*serve/)])
  })

  it("moves past a serve lock whose process is gone", () => {
    const { HOME, library, seed, run } = mac()
    seed(
      join(library("Application Support", "tg-cli"), "serve"),
      "default.lock",
      JSON.stringify({ pid: GONE, startedAt: "x" }),
    )

    run()

    expect(existsSync(join(HOME, ".local/share/tg-cli/serve/default.lock"))).toBe(true)
  })

  it("does nothing off macOS", () => {
    const { HOME, library, seed, warnings, env } = mac()
    seed(library("Preferences", "tg-cli"), "config.json")

    migrateFolders(app, { env, platform: "linux", warn: (line) => warnings.push(line) })

    expect(existsSync(join(HOME, ".config/tg-cli"))).toBe(false)
    expect(warnings).toEqual([])
  })
})

describe("the move into the WireCat folder", () => {
  const linux = () => {
    const HOME = mkdtempSync(join(tmpdir(), "wirecat-move-"))
    const old = join(HOME, ".local/share/cli-messaging")
    const next = join(HOME, ".local/share/WireCat")
    const seed = (dir: string, file: string, text = "x") => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    const warnings: string[] = []
    const env: NodeJS.ProcessEnv = { HOME }
    const run = () => migrateFolders(app, { env, platform: "linux", warn: (line) => warnings.push(line) })
    return { HOME, old, next, seed, warnings, env, run }
  }
  const SIBLINGS = ["wirecat.db-wal", "wirecat.db-shm", "wirecat.db.backup-1", "wirecat.db.before-restore-2"]

  it("moves the store with its journal and backups, and the models, once", () => {
    const { HOME, old, next, seed, warnings, run } = linux()
    seed(old, "wirecat.db", "rows")
    for (const name of SIBLINGS) seed(old, name, name)
    seed(old, "other.txt")
    seed(join(HOME, ".cache/cli-common/models/audio"), "m.bin", "model")

    run()

    expect(readFileSync(join(next, "wirecat.db"), "utf8")).toBe("rows")
    for (const name of SIBLINGS) expect(readFileSync(join(next, name), "utf8")).toBe(name)
    expect(readFileSync(join(next, "models/audio/m.bin"), "utf8")).toBe("model")
    expect(existsSync(join(old, "wirecat.db"))).toBe(false)
    expect(existsSync(join(old, "other.txt"))).toBe(true)
    expect(existsSync(join(HOME, ".cache/cli-common/models"))).toBe(false)
    expect(warnings).toEqual([])
  })

  it("keeps both stores and warns when the new one is already there", () => {
    const { old, next, seed, warnings, run } = linux()
    seed(old, "wirecat.db", "old")
    seed(next, "wirecat.db", "new")

    run()

    expect(readFileSync(join(old, "wirecat.db"), "utf8")).toBe("old")
    expect(readFileSync(join(next, "wirecat.db"), "utf8")).toBe("new")
    expect(warnings).toEqual([expect.stringMatching(/two stores/)])
  })

  it.each(["MESSAGING_STORE", "WIRECAT_STATE_DIR"])("moves nothing when %s is set", (name) => {
    const { HOME, old, seed, env, run } = linux()
    seed(old, "wirecat.db", "rows")
    env[name] = join(HOME, "elsewhere")

    run()

    expect(existsSync(join(old, "wirecat.db"))).toBe(true)
    expect(existsSync(join(HOME, ".local/share/WireCat"))).toBe(false)
  })

  it("leaves the store where it is while a serve runs, and uses the old file this run", () => {
    const { HOME, old, seed, warnings, env, run } = linux()
    seed(old, "wirecat.db", "rows")
    seed(join(HOME, ".local/share/tg-cli/serve"), "default.lock", JSON.stringify({ pid: process.ppid, startedAt: "x" }))

    run()

    expect(env.MESSAGING_STORE).toBe(join(old, "wirecat.db"))
    expect(existsSync(join(old, "wirecat.db"))).toBe(true)
    expect(warnings).toEqual([expect.stringMatching(/serve is running/)])
  })
})
