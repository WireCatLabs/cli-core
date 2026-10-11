import { describe, expect, it } from "vitest"
import { pathsAreOverridden, resolvePaths } from "./paths.js"

describe("resolvePaths", () => {
  it("derives the environment variable names from the app name", () => {
    const paths = resolvePaths({ appName: "max-cli", env: { MAX_CLI_CONFIG_DIR: "/tmp/cfg" } })
    expect(paths.config).toBe("/tmp/cfg")
  })

  it("takes an explicit prefix when the app name makes an awkward variable", () => {
    const paths = resolvePaths({ appName: "max-cli", prefix: "MAX", env: { MAX_STATE_DIR: "/tmp/state" } })
    expect(paths.state).toBe("/tmp/state")
  })

  it("falls back to the OS convention, and the three directories differ", () => {
    const paths = resolvePaths({ appName: "max-cli", env: {} })
    expect(paths.config).toContain("max-cli")
    expect(new Set([paths.config, paths.state, paths.cache]).size).toBe(3)
  })

  it("reports whether anything was overridden, which is what scopes the keyring", () => {
    expect(pathsAreOverridden({ appName: "max-cli", env: {} })).toBe(false)
    expect(pathsAreOverridden({ appName: "max-cli", env: { MAX_CLI_CACHE_DIR: "/tmp/c" } })).toBe(true)
  })

  it.each(["linux", "darwin"] as const)("gives the XDG layout under HOME on %s", (platform) => {
    expect(resolvePaths({ appName: "tg-cli", platform, env: { HOME: "/home/alice" } })).toEqual({
      config: "/home/alice/.config/tg-cli",
      state: "/home/alice/.local/share/tg-cli",
      cache: "/home/alice/.cache/tg-cli",
    })
  })

  it("reads the XDG variables from the env it is given, not the global one", () => {
    const env = { HOME: "/home/alice", XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "" }
    expect(resolvePaths({ appName: "tg-cli", platform: "darwin", env })).toEqual({
      config: "/x/config/tg-cli",
      state: "/x/data/tg-cli",
      cache: "/home/alice/.cache/tg-cli",
    })
  })

  it("keeps the Windows layout env-paths gave", () => {
    const env = { APPDATA: "C:\\Users\\alice\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }
    expect(resolvePaths({ appName: "tg-cli", platform: "win32", env })).toEqual({
      config: "C:\\Users\\alice\\AppData\\Roaming\\tg-cli\\Config",
      state: "C:\\Users\\alice\\AppData\\Local\\tg-cli\\Data",
      cache: "C:\\Users\\alice\\AppData\\Local\\tg-cli\\Cache",
    })
    expect(resolvePaths({ appName: "tg-cli", platform: "win32", env: { USERPROFILE: "C:\\Users\\bob" } }).config).toBe(
      "C:\\Users\\bob\\AppData\\Roaming\\tg-cli\\Config",
    )
  })

  it.each(["linux", "darwin", "win32"] as const)("lets the overrides win on %s", (platform) => {
    const env = { HOME: "/home/alice", TG_CONFIG_DIR: "/o/c", TG_STATE_DIR: "/o/s", TG_CACHE_DIR: "/o/k" }
    expect(resolvePaths({ appName: "tg-cli", prefix: "TG", platform, env })).toEqual({
      config: "/o/c",
      state: "/o/s",
      cache: "/o/k",
    })
  })
})
