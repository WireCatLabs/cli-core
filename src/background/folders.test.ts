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
    seed(library("Caches", "cli-common"), "model.bin")

    run()

    expect(existsSync(join(HOME, ".config/tg-cli/config.json"))).toBe(true)
    expect(readFileSync(join(HOME, ".local/share/cli-messaging/wirecat.db"), "utf8")).toBe("rows")
    expect(existsSync(join(HOME, ".cache/cli-common/model.bin"))).toBe(true)
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
