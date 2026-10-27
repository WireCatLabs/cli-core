import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { McpServer } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"
import { freePort } from "../../testing/mcp-http-client.js"
import { httpActivityFile, localDay } from "./activity.js"
import { serveOverHttp } from "./serve.js"
import { ACCESS_SECONDS, httpLockFile, REFRESH_SECONDS, readHttpLock, signedInClients } from "./state.js"

const tokenFileIn = () => join(mkdtempSync(join(tmpdir(), "mcp-state-")), "mcp-http", "personal.json")

const serve = async (tokenFile: string, port: number) =>
  serveOverHttp(() => new McpServer({ name: "test", version: "1" }), {
    publicUrl: new URL(`http://127.0.0.1:${port}`),
    port,
    tokenFile,
    appName: "chat",
    onCode: () => {},
    lockFile: httpLockFile(tokenFile),
    version: "1.2.3",
  })

describe("the lock a running HTTP server keeps", () => {
  it("holds the port, the address and the live login code, mode 600, and goes when the server closes", async () => {
    const tokenFile = tokenFileIn()
    const port = await freePort()
    const listening = await serve(tokenFile, port)
    const lock = readHttpLock(httpLockFile(tokenFile))

    expect(lock).toMatchObject({
      pid: process.pid,
      port,
      publicUrl: `http://127.0.0.1:${port}/`,
      version: "1.2.3",
      loginCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      listeningAt: expect.any(String),
    })
    expect(Date.parse(lock?.loginCodeExpiresAt ?? "")).toBeGreaterThan(Date.now())
    expect(statSync(httpLockFile(tokenFile)).mode & 0o777).toBe(0o600)

    await listening.close()
    expect(readHttpLock(httpLockFile(tokenFile))).toBeUndefined()
  })

  it("refuses a second server for the same token file and leaves the first one's lock", async () => {
    const tokenFile = tokenFileIn()
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
    try {
      const lock = { pid: other.pid ?? 0, startedAt: "2026-10-26T10:00:00Z", port: 1, publicUrl: "https://x.example/" }
      mkdirSync(dirname(tokenFile), { recursive: true })
      writeFileSync(httpLockFile(tokenFile), JSON.stringify(lock))

      await expect(serve(tokenFile, await freePort())).rejects.toThrow(/already serves MCP over HTTP .* port 1 \(PID/)
      expect(readHttpLock(httpLockFile(tokenFile))?.pid).toBe(other.pid)
    } finally {
      other.kill()
    }
  })

  it("lets the lock go when the port is taken", async () => {
    const tokenFile = tokenFileIn()
    const port = await freePort()
    const first = await serve(tokenFileIn(), port)
    try {
      await expect(serve(tokenFile, port)).rejects.toThrow()
      expect(readHttpLock(httpLockFile(tokenFile))).toBeUndefined()
    } finally {
      await first.close()
    }
  })
})

describe("signed-in apps", () => {
  it("lists only apps holding an unexpired token, with the name they gave and their last login, no ids", () => {
    const tokenFile = tokenFileIn()
    const now = Date.parse("2026-10-26T12:00:00Z")
    const seconds = now / 1000
    mkdirSync(dirname(tokenFile), { recursive: true })
    writeFileSync(
      tokenFile,
      JSON.stringify({
        clients: [
          { id: "a", name: "Claude", redirectUris: [], authMethod: "none", issuedAt: 0 },
          { id: "b", redirectUris: [], authMethod: "none", issuedAt: 0 },
          { id: "c", name: "Gone", redirectUris: [], authMethod: "none", issuedAt: 0 },
          { id: "d", name: "Never logged in", redirectUris: [], authMethod: "none", issuedAt: 0 },
        ],
        tokens: [
          { hash: "1", kind: "access", clientId: "a", expiresAt: seconds + ACCESS_SECONDS - 60 },
          { hash: "2", kind: "refresh", clientId: "a", expiresAt: seconds + REFRESH_SECONDS - 60 },
          { hash: "3", kind: "refresh", clientId: "b", expiresAt: seconds + 3600 },
          { hash: "4", kind: "refresh", clientId: "c", expiresAt: seconds - 1 },
        ],
      }),
    )

    const clients = signedInClients(tokenFile, now)

    const quiet = { lastRequestAt: null, lastTool: null, lastToolAt: null, toolCallsToday: 0 }
    expect(clients).toEqual([
      { claimedName: "Claude", lastLoginAt: new Date(now - 60_000).toISOString(), ...quiet },
      {
        claimedName: null,
        lastLoginAt: new Date((seconds + 3600 - REFRESH_SECONDS) * 1000).toISOString(),
        ...quiet,
      },
    ])
    expect(JSON.stringify(clients)).not.toMatch(/"a"|"b"/)
  })

  it("adds each app's last call and today's calls from the activity file, zero from another day", () => {
    const tokenFile = tokenFileIn()
    const now = new Date(2026, 9, 27, 12, 0).getTime()
    const seconds = Math.floor(now / 1000)
    mkdirSync(dirname(tokenFile), { recursive: true })
    const app = (id: string) => ({ id, name: id, redirectUris: [], authMethod: "none", issuedAt: 0 })
    writeFileSync(
      tokenFile,
      JSON.stringify({
        clients: [app("today"), app("yesterday")],
        tokens: ["today", "yesterday"].map((id) => ({
          hash: id,
          kind: "refresh",
          clientId: id,
          expiresAt: seconds + 60,
        })),
      }),
    )
    const at = "2026-10-27T11:58:00.000Z"
    writeFileSync(
      httpActivityFile(tokenFile),
      JSON.stringify({
        today: { lastRequestAt: at, lastTool: "tg_read", lastToolAt: at, day: localDay(now), toolCalls: 3 },
        yesterday: { lastRequestAt: at, day: "2026-10-26", toolCalls: 9 },
      }),
    )

    const clients = signedInClients(tokenFile, now)

    expect(clients.find((c) => c.claimedName === "today")).toMatchObject({ lastTool: "tg_read", toolCallsToday: 3 })
    expect(clients.find((c) => c.claimedName === "yesterday")).toMatchObject({ lastTool: null, toolCallsToday: 0 })
  })

  it("is empty without a token file", () => {
    expect(signedInClients(tokenFileIn())).toEqual([])
  })
})
