import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  type AfterUpgradeSystem,
  isStdioMcp,
  packageRootOf,
  restartMcpServers,
  staleMcpSessions,
  thisSystem,
} from "./after-upgrade.js"
import { holdLock, lockPath } from "./lock.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", version: "1.0.0", description: "Synthetic CLI" }
const OLD = 4100
const NEW = 4200

const setup = (where: string[] = ["mcp-http", "personal"], launch: object | null = {}) => {
  const state = mkdtempSync(join(tmpdir(), "after-upgrade-"))
  const env = { APP_STATE_DIR: state, APP_TIMEOUT: "30s", PATH: "/bin" }
  const lockFile = `${join(state, ...where)}.lock`
  mkdirSync(join(lockFile, ".."), { recursive: true })
  holdLock(lockFile, {
    pid: OLD,
    startedAt: "2026-10-27T10:00:00.000Z",
    listeningAt: "2026-10-27T10:00:01.000Z",
    version: "1.0.0",
    port: 8765,
    publicUrl: "https://laptop.example.ts.net/",
  } as never)
  if (launch !== null)
    writeFileSync(
      `${lockFile.replace(/\.lock$/, "")}.launch.json`,
      JSON.stringify({
        invocation: "app personal",
        argv: [
          "mcp",
          "--http",
          "--port",
          "8765",
          "--public-url",
          "https://laptop.example.ts.net",
          "--permission",
          "messages.send=deny",
        ],
        env: { APP_MCP_HTTP: "personal", APP_PROFILE: "personal" },
        ...launch,
      }),
    )
  const running = new Set([OLD])
  const spawned: { argv: string[]; env: NodeJS.ProcessEnv; log: string }[] = []
  const system: AfterUpgradeSystem = {
    platform: "linux",
    alive: (pid) => running.has(pid),
    carries: (pid, marker) => running.has(pid) && marker === "APP_MCP_HTTP=personal",
    stop: vi.fn((pid: number) => {
      running.delete(pid)
    }),
    spawn: (argv, childEnv, log) => {
      spawned.push({ argv, env: childEnv, log })
      running.add(NEW)
      holdLock(lockFile, {
        pid: NEW,
        startedAt: "2026-10-27T11:00:00.000Z",
        listeningAt: "2026-10-27T11:00:01.000Z",
        version: "2.0.0",
        port: 8765,
        publicUrl: "https://laptop.example.ts.net/",
      } as never)
      return NEW
    },
    pause: async () => {},
    processes: () => [],
    packageRoot: undefined,
  }
  return { env, lockFile, running, spawned, system }
}

describe("restartMcpServers", () => {
  it("restarts a running HTTP server on the new code with the port, address and permission limits it had", async () => {
    const { env, system, spawned } = setup()
    expect(await restartMcpServers(app, env, system)).toEqual([
      { name: "app personal", pid: OLD, restarted: true, from: "1.0.0", to: "2.0.0", newPid: NEW },
    ])
    expect(system.stop).toHaveBeenCalledWith(OLD)
    expect(spawned[0]?.argv).toContain("messages.send=deny")
    expect(spawned[0]?.env).toMatchObject({ APP_MCP_HTTP: "personal", APP_PROFILE: "personal", PATH: "/bin" })
    expect(spawned[0]?.env.APP_TIMEOUT).toBeUndefined()
  })

  it("finds a lock a CLI keeps deeper in its state folder, and ignores serve's locks", async () => {
    const { env, system } = setup(["profiles", "work", "mcp-http"])
    holdLock(lockPath(app, "personal", env), { pid: OLD, startedAt: "2026-10-27T10:00:00.000Z" })
    const done = await restartMcpServers(app, env, system)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ restarted: true, to: "2.0.0" })
  })

  it("does nothing when no server runs", async () => {
    const { env, system, running } = setup()
    running.clear()
    expect(await restartMcpServers(app, env, system)).toEqual([])
    expect(system.stop).not.toHaveBeenCalled()
  })

  it("leaves a server it cannot confirm was started by `mcp server start` running", async () => {
    for (const launch of [null, { env: { APP_MCP_HTTP: "work" } }]) {
      const { env, system } = setup(undefined, launch)
      const [one] = await restartMcpServers(app, env, system)
      expect(one).toMatchObject({ restarted: false, pid: OLD, from: "1.0.0", to: null })
      expect(one?.reason).toContain("stop it and start it again")
      expect(system.stop).not.toHaveBeenCalled()
    }
  })

  it("leaves a server it is not allowed to stop", async () => {
    const { env, system } = setup()
    system.stop = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    }
    const [one] = await restartMcpServers(app, env, system)
    expect(one).toMatchObject({ restarted: false, reason: "not allowed to stop it" })
  })

  it("says so when the old server does not stop in time, and starts no second one", async () => {
    const { env, system, spawned } = setup()
    system.stop = () => {}
    const [one] = await restartMcpServers(app, env, system)
    expect(one).toMatchObject({ restarted: false })
    expect(one?.reason).toContain("still ran after 15 s")
    expect(spawned).toEqual([])
  })

  it("says so when the new server does not listen in time", async () => {
    const { env, system, running } = setup()
    system.spawn = () => {
      running.add(NEW)
      return NEW
    }
    const [one] = await restartMcpServers(app, env, system)
    expect(one).toMatchObject({ restarted: false, newPid: NEW })
    expect(one?.reason).toContain("not listening after 30 s — `app personal mcp server status`")
  })

  it("keeps --profiles in the command it suggests for a server of several profiles", async () => {
    const { env, system, running } = setup(undefined, {
      invocation: "app",
      argv: ["mcp", "serve", "--http", "--profiles", "work,personal"],
    })
    system.spawn = () => {
      running.add(NEW)
      return NEW
    }
    const [one] = await restartMcpServers(app, env, system)
    expect(one?.reason).toContain("`app mcp server status --profiles work,personal`")
  })

  it("names the log's last line when the new server exits before it listens", async () => {
    const { env, system } = setup()
    system.spawn = (_argv, _env, log) => {
      writeFileSync(log, "port 8765 is in use — pass another with --port\n")
      return NEW
    }
    const [one] = await restartMcpServers(app, env, system)
    expect(one).toMatchObject({ restarted: false, newPid: NEW })
    expect(one?.reason).toContain("exited before it listened: port 8765 is in use")
    expect(one?.reason).toContain("`app personal mcp server start`")
  })

  it("says so when the new server cannot be started at all", async () => {
    const { env, system } = setup()
    system.spawn = () => {
      throw new Error("spawn ENOENT")
    }
    const [one] = await restartMcpServers(app, env, system)
    expect(one?.reason).toContain("could not start it again: spawn ENOENT")
  })
})

describe("stdio MCP sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "after-upgrade-pkg-"))
  const script = join(root, "dist", "bin", "app.js")
  mkdirSync(join(root, "dist", "bin"), { recursive: true })
  writeFileSync(script, "")
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@synthetic/app" }))
  const link = join(mkdtempSync(join(tmpdir(), "after-upgrade-bin-")), "app")
  symlinkSync(script, link)

  it("knows the package a script belongs to, and not a runner's", () => {
    expect(packageRootOf("@synthetic/app", script)).toBe(root)
    expect(packageRootOf("@synthetic/other", script)).toBeUndefined()
  })

  it.each([
    [["node", script, "personal", "mcp"], true],
    [["node", "--enable-source-maps", script, "mcp", "--permission", "messages.send=deny"], true],
    [["node", link, "personal", "mcp"], true],
    [["node", script, "personal", "mcp", "--http", "--port", "8765"], false],
    [["node", script, "personal", "mcp", "serve"], true],
    [["node", script, "personal", "bot", "mcp", "serve"], true],
    [["node", script, "personal", "mcp", "serve", "--http", "--port", "8765"], false],
    [["node", script, "personal", "mcp", "server", "status"], false],
    [["node", script, "personal", "mcp", "config"], false],
    [["node", script, "personal", "serve"], false],
    [["node", "/elsewhere/app.js", "mcp"], false],
    [["node", "app.js", "mcp"], false],
  ])("tells a stdio session from other commands: %j", (line, expected) => {
    expect(isStdioMcp(line, root)).toBe(expected)
  })

  const system = (lines: ReturnType<AfterUpgradeSystem["processes"]>, packageRoot: string | null = root) =>
    ({ platform: "linux", processes: () => lines, packageRoot: packageRoot ?? undefined }) as AfterUpgradeSystem

  it("lists the sessions of this install and leaves out this process", () => {
    expect(
      staleMcpSessions(
        system([
          { pid: 11, words: ["node", script, "personal", "mcp"] },
          { pid: 12, words: ["node", script, "mcp", "--http"] },
          { pid: process.pid, words: ["node", script, "mcp"] },
        ]),
      ),
    ).toEqual({ checked: true, sessions: [{ pid: 11, version: null }] })
  })

  it("says it could not check rather than claiming none", () => {
    expect(staleMcpSessions(system(undefined))).toMatchObject({ checked: false, sessions: [] })
    expect(staleMcpSessions(system([], null))).toMatchObject({ checked: false, sessions: [] })
  })
})

describe("thisSystem", () => {
  it("is not run from an installed package under a test runner, and lists this user's processes on Linux", () => {
    const system = thisSystem("@synthetic/app", "app")
    expect(system.packageRoot).toBeUndefined()
    if (process.platform === "linux") expect(system.processes()?.map((line) => line.pid)).toContain(process.pid)
  })
})
