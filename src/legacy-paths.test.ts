import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isCliError } from "./errors.js"
import { legacyMacPaths, migrateLegacyMacPaths } from "./legacy-paths.js"

const darwinHome = () => {
  const HOME = mkdtempSync(join(tmpdir(), "legacy-paths-"))
  const old = legacyMacPaths("tg-cli", { HOME })
  return { HOME, old }
}

const seed = (dir: string, file = "wirecat.db", text = "rows") => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), text)
}

const free = () => []
const options = () => ({ appName: "tg-cli", prefix: "TG", platform: "darwin" as const, holders: free })

describe("migrateLegacyMacPaths", () => {
  it("moves each ~/Library folder to its XDG place when only the old one exists", () => {
    const { HOME, old } = darwinHome()
    seed(old.config, "config.json", "{}")
    seed(old.state)
    seed(join(old.state, "sessions"), "a.json")

    const moves = migrateLegacyMacPaths({ ...options(), env: { HOME } })

    expect(moves).toEqual([
      { kind: "config", from: old.config, to: join(HOME, ".config/tg-cli"), copied: false },
      { kind: "state", from: old.state, to: join(HOME, ".local/share/tg-cli"), copied: false },
    ])
    expect(readFileSync(join(HOME, ".local/share/tg-cli/wirecat.db"), "utf8")).toBe("rows")
    expect(existsSync(join(HOME, ".local/share/tg-cli/sessions/a.json"))).toBe(true)
    expect(existsSync(old.state)).toBe(false)
    expect(migrateLegacyMacPaths({ ...options(), env: { HOME } })).toEqual([])
  })

  it("moves into an empty new folder, which an early mkdir may have left", () => {
    const { HOME, old } = darwinHome()
    seed(old.cache, "x")
    mkdirSync(join(HOME, ".cache/tg-cli"), { recursive: true })

    expect(migrateLegacyMacPaths({ ...options(), env: { HOME } })).toHaveLength(1)
    expect(existsSync(join(HOME, ".cache/tg-cli/x"))).toBe(true)
  })

  it("never merges into a new folder that has something in it", () => {
    const { HOME, old } = darwinHome()
    seed(old.state, "wirecat.db", "old")
    seed(join(HOME, ".local/share/tg-cli"), "wirecat.db", "new")

    expect(migrateLegacyMacPaths({ ...options(), env: { HOME } })).toEqual([])
    expect(readFileSync(join(old.state, "wirecat.db"), "utf8")).toBe("old")
    expect(readFileSync(join(HOME, ".local/share/tg-cli/wirecat.db"), "utf8")).toBe("new")
  })

  it("does nothing when any directory is overridden", () => {
    const { HOME, old } = darwinHome()
    seed(old.state)

    expect(migrateLegacyMacPaths({ ...options(), env: { HOME, TG_CACHE_DIR: join(HOME, "c") } })).toEqual([])
    expect(existsSync(old.state)).toBe(true)
  })

  it.each(["linux", "win32"] as const)("does nothing on %s", (platform) => {
    const { HOME, old } = darwinHome()
    seed(old.state)

    expect(migrateLegacyMacPaths({ ...options(), platform, env: { HOME } })).toEqual([])
    expect(existsSync(old.state)).toBe(true)
  })

  it("refuses to move anything while a process holds a file in any pending folder", () => {
    const { HOME, old } = darwinHome()
    seed(old.config, "config.json")
    seed(old.state)
    let asked: string[] = []
    const holders = (dirs: string[]) => {
      asked = dirs
      return ["pid 4242"]
    }

    let thrown: unknown
    try {
      migrateLegacyMacPaths({ ...options(), holders, env: { HOME } })
    } catch (error) {
      thrown = error
    }

    expect(isCliError(thrown) && thrown.details.busy).toEqual(["pid 4242"])
    expect(asked).toEqual([old.config, old.state])
    expect(existsSync(old.config) && existsSync(old.state)).toBe(true)
    expect(existsSync(join(HOME, ".config/tg-cli"))).toBe(false)
  })

  it("does not ask who holds files when there is nothing to move", () => {
    const { HOME } = darwinHome()
    const holders = () => {
      throw new Error("should not be called")
    }
    expect(migrateLegacyMacPaths({ ...options(), holders, env: { HOME } })).toEqual([])
  })

  it("copies across file systems, checks the copy, and keeps the old folder", () => {
    const { HOME, old } = darwinHome()
    seed(old.state)
    seed(join(old.state, "runs"), "r.json")
    const crossDevice = () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" })
    }

    const moves = migrateLegacyMacPaths({ ...options(), rename: crossDevice, env: { HOME } })

    expect(moves).toEqual([{ kind: "state", from: old.state, to: join(HOME, ".local/share/tg-cli"), copied: true }])
    expect(existsSync(join(HOME, ".local/share/tg-cli/runs/r.json"))).toBe(true)
    expect(existsSync(join(old.state, "wirecat.db"))).toBe(true)
  })

  it("treats a folder another process moved first as done", () => {
    const { HOME, old } = darwinHome()
    seed(old.state)
    const raced = (from: string, to: string) => {
      renameSync(from, to)
      throw Object.assign(new Error("no such file"), { code: "ENOENT" })
    }

    expect(migrateLegacyMacPaths({ ...options(), rename: raced, env: { HOME } })).toEqual([])
    expect(existsSync(join(HOME, ".local/share/tg-cli/wirecat.db"))).toBe(true)
  })

  it("reports what already moved when a later move fails", () => {
    const { HOME, old } = darwinHome()
    seed(old.config, "config.json")
    seed(old.state)
    const failOnState = (from: string, to: string) => {
      if (from === old.state) throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      renameSync(from, to)
    }

    expect(() => migrateLegacyMacPaths({ ...options(), rename: failOnState, env: { HOME } })).toThrow(
      /could not move .*permission denied/,
    )
    expect(existsSync(join(HOME, ".config/tg-cli/config.json"))).toBe(true)
  })
})
