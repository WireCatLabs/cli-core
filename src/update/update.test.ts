import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CHECK_EVERY_MS,
  checkIsDue,
  installerOf,
  isNewer,
  latestVersion,
  mayNotify,
  readUpdateState,
  runUpdate,
  spawnPlan,
  updateCommand,
  updateNotice,
  writeUpdateState,
} from "./index.js"

describe("installerOf", () => {
  it("reads the package manager from where the running file really lives", () => {
    expect(
      installerOf(
        "/home/a/.local/share/pnpm/store/v11/links/@wirecat/max-cli/0.6.0/abc/node_modules/@wirecat/max-cli/dist/bin/max.js",
      ),
    ).toBe("pnpm")
    expect(installerOf("/usr/local/lib/node_modules/@wirecat/max-cli/dist/bin/max.js")).toBe("npm")
    expect(installerOf("/home/a/.bun/install/global/node_modules/@wirecat/max-cli/dist/bin/max.js")).toBe("bun")
    expect(installerOf("/home/a/.npm/_npx/1a2b/node_modules/@wirecat/max-cli/dist/bin/max.js")).toBe("npx")
    expect(installerOf("/home/a/Projects/max-cli/dist/bin/max.js")).toBe("checkout")
    expect(installerOf("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@wirecat\\max-cli\\dist\\bin\\max.js")).toBe(
      "npm",
    )
  })
})

describe("updateCommand", () => {
  it("names the package manager's own global install of the latest version", () => {
    expect(updateCommand("pnpm", "@wirecat/max-cli")).toEqual(["pnpm", "add", "-g", "@wirecat/max-cli@latest"])
    expect(updateCommand("npm", "@wirecat/max-cli")).toEqual(["npm", "install", "-g", "@wirecat/max-cli@latest"])
    expect(updateCommand("bun", "@wirecat/max-cli")).toEqual(["bun", "add", "-g", "@wirecat/max-cli@latest"])
  })

  it("has nothing to run for a checkout, npx or an install it cannot place", () => {
    for (const installer of ["checkout", "npx", "unknown"] as const) {
      expect(updateCommand(installer, "@wirecat/max-cli")).toBeUndefined()
    }
  })
})

describe("isNewer", () => {
  it("compares plain versions part by part, not as text", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true)
    expect(isNewer("0.6.0", "0.6.0")).toBe(false)
    expect(isNewer("0.5.9", "0.6.0")).toBe(false)
  })

  it("never offers a pre-release or something unparseable", () => {
    expect(isNewer("0.7.0-beta.1", "0.6.0")).toBe(false)
    expect(isNewer("latest", "0.6.0")).toBe(false)
  })
})

describe("latestVersion", () => {
  it("reads the version npm reports as latest", async () => {
    const fetch = async () => new Response(JSON.stringify({ version: "0.7.0" }))
    expect(await latestVersion("@wirecat/max-cli", fetch)).toBe("0.7.0")
  })

  it("answers undefined, never throws, when npm fails, refuses or is too slow", async () => {
    expect(await latestVersion("x", async () => new Response("nope", { status: 503 }))).toBeUndefined()
    expect(
      await latestVersion("x", async () => {
        throw new Error("offline")
      }),
    ).toBeUndefined()
    const slow = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )
    expect(await latestVersion("x", slow, { timeoutMs: 20 })).toBeUndefined()
  })
})

describe("mayNotify", () => {
  const person = {
    format: "pretty",
    stderrIsTTY: true,
    quiet: false,
    enabled: true,
    installer: "pnpm" as const,
    env: {},
  }

  it("tells a person at a terminal", () => {
    expect(mayNotify(person)).toBe(true)
  })

  it("tells nobody who reads JSON, a pipe, --quiet, CI or anyone who turned it off", () => {
    expect(mayNotify({ ...person, format: "json" })).toBe(false)
    expect(mayNotify({ ...person, stderrIsTTY: false })).toBe(false)
    expect(mayNotify({ ...person, quiet: true })).toBe(false)
    expect(mayNotify({ ...person, enabled: false })).toBe(false)
    expect(mayNotify({ ...person, env: { CI: "true" } })).toBe(false)
    expect(mayNotify({ ...person, env: { NO_UPDATE_NOTIFIER: "1" } })).toBe(false)
    expect(mayNotify({ ...person, env: { MAX_NO_UPDATE_CHECK: "1" }, offVariables: ["MAX_NO_UPDATE_CHECK"] })).toBe(
      false,
    )
  })

  it("tells nobody whose install it could not update", () => {
    expect(mayNotify({ ...person, installer: "checkout" })).toBe(false)
    expect(mayNotify({ ...person, installer: "npx" })).toBe(false)
  })
})

describe("the check's state", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const file = () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-core-update-"))
    dirs.push(dir)
    return join(dir, "state", "update-check.json")
  }

  it("is due when never checked, and again a day later", () => {
    expect(checkIsDue(undefined, 1000)).toBe(true)
    expect(checkIsDue({ checkedAt: 1000 }, 1000 + CHECK_EVERY_MS - 1)).toBe(false)
    expect(checkIsDue({ checkedAt: 1000 }, 1000 + CHECK_EVERY_MS)).toBe(true)
  })

  it("round-trips, creating the directory", () => {
    const path = file()
    writeUpdateState(path, { checkedAt: 42, latest: "0.7.0" })
    expect(readUpdateState(path)).toEqual({ checkedAt: 42, latest: "0.7.0" })
  })

  it("reads a missing or broken file as never checked", () => {
    const path = file()
    expect(readUpdateState(path)).toBeUndefined()
    writeUpdateState(path, { checkedAt: 1 })
    writeFileSync(path, "{ not json")
    expect(readUpdateState(path)).toBeUndefined()
  })
})

describe("spawnPlan and runUpdate", () => {
  it("passes separate arguments and resolves Windows commands from trusted PATH entries", () => {
    expect(spawnPlan(["npm", "install", "-g", "x@latest"], "linux")).toEqual({
      file: "npm",
      args: ["install", "-g", "x@latest"],
      shell: false,
    })
    expect(
      spawnPlan(["npm", "install", "-g", "x@latest"], "win32", { PATH: "C:\\Tools", PATHEXT: ".CMD" }, () => true),
    ).toEqual({
      file: "C:\\Tools\\npm.CMD",
      args: ["install", "-g", "x@latest"],
      shell: false,
    })
  })

  it("answers the package manager's exit code", () => {
    expect(runUpdate([process.execPath, "-e", "process.exit(3)"])).toBe(3)
  })

  it("throws, naming it, when the package manager cannot be started", () => {
    expect(() => runUpdate(["no-such-package-manager-anywhere"])).toThrow(/no-such-package-manager-anywhere/)
  })
})

describe("updateNotice", () => {
  const npm =
    (version: string | undefined, calls: string[] = []) =>
    async (url: string | URL | Request) => {
      calls.push(String(url))
      if (version === undefined) throw new Error("offline")
      return new Response(JSON.stringify({ version }))
    }

  const request = (overrides: Partial<Parameters<typeof updateNotice>[0]> = {}) => ({
    argv: ["campaigns", "list"],
    packageName: "@leemour/tool",
    command: "tool",
    version: "1.0.0",
    statePath: join(mkdtempSync(join(tmpdir(), "cli-core-notice-")), "update-check.json"),
    fetch: npm("1.1.0"),
    format: "pretty",
    stderrIsTTY: true,
    quiet: false,
    enabled: true,
    installer: "npm" as const,
    env: {},
    ...overrides,
  })

  it("tells a person a newer version is out, and how to get it", async () => {
    expect(await updateNotice(request())).toBe("tool 1.1.0 is out — you have 1.0.0. `tool update` installs it.")
  })

  it.each([
    ["after a profile name", ["prod", "update"]],
    ["after an option's value", ["--profile", "prod", "update"]],
    ["during completion", ["complete", "--", "camp"]],
  ])("says nothing about update or complete, wherever the word is — %s", async (_name, argv) => {
    const calls: string[] = []

    expect(await updateNotice(request({ argv, fetch: npm("1.1.0", calls) }))).toBeUndefined()
    expect(calls).toEqual([])
  })

  it("says nothing when npm cannot be reached, or has nothing newer", async () => {
    expect(await updateNotice(request({ fetch: npm(undefined) }))).toBeUndefined()
    expect(await updateNotice(request({ fetch: npm("1.0.0") }))).toBeUndefined()
  })

  it("asks npm at most once a day, and again the day after", async () => {
    const calls: string[] = []
    const statePath = request().statePath
    const at = (now: number) => request({ statePath, fetch: npm("1.1.0", calls), now: () => now })

    await updateNotice(at(1_000))
    await updateNotice(at(1_000 + CHECK_EVERY_MS - 1))
    expect(calls).toHaveLength(1)

    await updateNotice(at(1_000 + CHECK_EVERY_MS))
    expect(calls).toHaveLength(2)
  })

  it("never reaches npm for someone who would not be told", async () => {
    const calls: string[] = []

    expect(await updateNotice(request({ format: "json", fetch: npm("1.1.0", calls) }))).toBeUndefined()
    expect(calls).toEqual([])
  })
})
