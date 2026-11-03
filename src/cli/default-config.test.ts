import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, ensureDefaultConfig } from "./default-config.js"
import { settingsFor } from "./settings.js"

describe("first-run configuration", () => {
  it("creates absent parent directories, publishes complete JSON and removes its temporary files", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "starter-")), "new", "config")
    const path = join(directory, "config.json")
    ensureDefaultConfig(path)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(DEFAULT_CONFIG)
    expect(readdirSync(directory)).toEqual(["config.json"])
    ensureDefaultConfig(path)
    expect(readdirSync(directory)).toEqual(["config.json"])
  })

  it("preserves existing settings and invalid JSON byte for byte", () => {
    const path = join(mkdtempSync(join(tmpdir(), "starter-")), "config.json")
    for (const original of ['{"profiles":{"work":{"limit":7}}}', "invalid JSON"]) {
      writeFileSync(path, original)
      ensureDefaultConfig(path)
      expect(readFileSync(path, "utf8")).toBe(original)
    }
  })

  it("uses the requested config directory without storing flags or environment values", () => {
    const directory = mkdtempSync(join(tmpdir(), "starter-"))
    const app = { command: "app", appName: "app-cli", envPrefix: "APP", version: "test", description: "" }
    const { resolveSettings } = settingsFor(app)
    const result = resolveSettings(
      { limit: 9, profile: "work" },
      { env: { APP_CONFIG_DIR: directory, APP_TIMEOUT: "1s" } },
    )
    expect(result.limit).toBe(9)
    expect(result.commandTimeoutMs).toBe(1000)
    expect(existsSync(result.configPath)).toBe(true)
    expect(JSON.parse(readFileSync(result.configPath, "utf8"))).toMatchObject(DEFAULT_CONFIG)
    writeFileSync(result.configPath, "invalid JSON")
    expect(() => resolveSettings({}, { env: { APP_CONFIG_DIR: directory } })).toThrow("not valid JSON")
  })
})
