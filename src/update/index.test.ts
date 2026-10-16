import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { appUpdate, type UpdateEnvironment } from "./index.js"

const PNPM =
  "/home/a/.local/share/pnpm/store/v11/links/@wirecat/demo-cli/0.6.0/x/node_modules/@wirecat/demo-cli/dist/update.js"

const setup = (latest: string | Error = "99.0.0", enabled: (env: NodeJS.ProcessEnv) => boolean = () => true) => {
  const home = mkdtempSync(join(tmpdir(), "core-update-"))
  const env: NodeJS.ProcessEnv = { ...process.env, DEMO_NO_UPDATE_CHECK: undefined, CI: undefined }
  let asked = 0
  let now = 1_000_000
  const environment: UpdateEnvironment = {
    scriptPath: PNPM,
    stderrIsTTY: true,
    now: () => now,
    fetch: async () => {
      asked += 1
      if (latest instanceof Error) throw latest
      return new Response(JSON.stringify({ version: latest }))
    },
  }
  const update = appUpdate({
    packageName: "@wirecat/demo-cli",
    command: "demo",
    version: "1.0.0",
    entry: import.meta.url,
    statePath: () => join(home, "update-check.json"),
    enabled,
    offVariables: ["DEMO_NO_UPDATE_CHECK"],
  })
  const notice = (argv = ["chats", "list"], tty = true) => update.updateNotice(argv, { tty, environment, env })
  return { env, notice, update, asked: () => asked, later: (ms: number) => (now += ms) }
}

describe("the daily line about a newer version", () => {
  it("tells a person at a terminal that a newer version exists", async () => {
    expect(await setup().notice()).toMatch(/demo 99\.0\.0 is out — you have 1\.0\.0\. `demo upgrade` installs it/)
  })

  it("tells nobody reading JSON, a pipe, --quiet, CI or its own variable — and then does not ask npm", async () => {
    const { notice, asked, env } = setup()
    expect(await notice(["chats", "list", "--json"])).toBeUndefined()
    expect(await notice(["chats", "list", "--json=id"])).toBeUndefined()
    expect(await notice(["chats", "list"], false)).toBeUndefined()
    expect(await notice(["chats", "list", "--quiet"])).toBeUndefined()
    env.DEMO_NO_UPDATE_CHECK = "1"
    expect(await notice()).toBeUndefined()
    env.DEMO_NO_UPDATE_CHECK = undefined
    env.CI = "true"
    expect(await notice()).toBeUndefined()
    expect(asked()).toBe(0)
  })

  it("asks npm at most once a day, and keeps telling from what it last heard", async () => {
    const { notice, asked, later } = setup()
    await notice()
    later(60 * 60 * 1000)
    expect(await notice()).toMatch(/99\.0\.0/)
    expect(asked()).toBe(1)
    later(24 * 60 * 60 * 1000)
    await notice()
    expect(asked()).toBe(2)
  })

  it("says nothing, and fails nothing, when npm cannot be reached or the version is the newest", async () => {
    expect(await setup(new Error("offline")).notice()).toBeUndefined()
    expect(await setup("0.0.1").notice()).toBeUndefined()
  })

  it("stays off when the setting is off or the config cannot be read", async () => {
    const off = setup("99.0.0", () => false)
    expect(await off.notice()).toBeUndefined()
    const broken = setup("99.0.0", () => {
      throw new Error("config.json: not JSON")
    })
    expect(await broken.notice()).toBeUndefined()
    expect(off.asked() + broken.asked()).toBe(0)
  })

  it("never runs for a Tab or for upgrade itself", async () => {
    const { notice, asked } = setup()
    expect(await notice(["complete", "--", "ch"])).toBeUndefined()
    expect(await notice(["upgrade"])).toBeUndefined()
    expect(await notice(["--timeout", "30s", "upgrade"])).toBeUndefined()
    expect(asked()).toBe(0)
  })

  it("reads the installer from the app's script", () => {
    expect(setup().update.installer({ scriptPath: PNPM })).toBe("pnpm")
  })
})

describe("starting the package manager", () => {
  it("really starts npm on this platform", () => {
    expect(setup().update.runUpdate(["npm", "--version"])).toBe(0)
  })

  it("fails loudly when the package manager cannot be started", () => {
    expect(() => setup().update.runUpdate(["cli-core-no-such-installer", "--version"])).toThrow(
      /cli-core-no-such-installer/,
    )
  })
})
