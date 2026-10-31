import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServerContext } from "@modelcontextprotocol/server"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { itemOf } from "../cli/envelope.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { agentLog } from "./agent-log.js"
import { callingAgent } from "./caller.js"
import { type AnyTool, entryRunner, READ, type Registration, type ToolCall, tierOf, tool, WRITE } from "./tool.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const echo = tool({
  title: "Echo",
  description: "says it back",
  input: v.strictObject({ text: v.string() }),
  annotations: WRITE,
  local: async ({ text }) => itemOf({ said: text }),
})
const refusing = tool({
  title: "Refuse",
  description: "always refused",
  input: v.strictObject({ text: v.string() }),
  annotations: READ,
  local: async () => {
    throw new CliError("permission_error", "profile denies it")
  },
})

const runner = (store: MessageStore, messenger?: { quietPins: boolean }) =>
  entryRunner({
    log: async (call: ToolCall) => {
      await store.agentActions.record({ actor: { bot: "test-mcp" }, ...call })
    },
    defaults: { settings: {}, env: {} },
    messenger,
  } as unknown as Registration)

const ctx = { mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext

describe("the MCP agent log", () => {
  it("leaves one row per tool call, with its tier and outcome and none of its text", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-log-")), "store.db")
    const store = await openStore({ path })
    live.push(store)
    const run = runner(store)

    const answer = await run("messages_send", echo as AnyTool, { text: "secret words" }, ctx)
    expect(answer.structuredContent).toMatchObject({ item: { said: "secret words" } })
    await run("chats_show", refusing as AnyTool, { text: "more secret words" }, ctx)

    const rows = await store.agentActions.list()
    expect(rows.map(({ tool, tier, status, error }) => ({ tool, tier, status, error }))).toEqual([
      { tool: "chats_show", tier: "read", status: "refused", error: "permission_error" },
      { tool: "messages_send", tier: "write-public", status: "ok", error: null },
    ])
    const database = await openCache(path)
    const raw = JSON.stringify(database.prepare("SELECT * FROM agent_actions").all())
    database.close()
    expect(raw).not.toContain("secret")
  })

  it("names the agent by the client that made the call", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "agent-log-")), "store.db") })
    live.push(store)
    const run = entryRunner({
      log: async (call: ToolCall, caller: Parameters<typeof callingAgent>[1]) => {
        await store.agentActions.record({ actor: { bot: callingAgent("test-mcp", caller) }, ...call })
      },
      callers: { env: {}, client: () => ({ name: "hermes", version: "1" }) },
      defaults: { settings: {}, env: {} },
    } as unknown as Registration)

    await run("messages_send", echo as AnyTool, { text: "" }, ctx)

    expect((await store.agentActions.list()).map(({ actor }) => actor.name)).toEqual(["hermes"])
  })

  it("logs a pin as a write others see where every pin tells the chat's members", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "agent-log-")), "store.db") })
    live.push(store)

    await runner(store, { quietPins: false })("messages_pin", echo as AnyTool, { text: "" }, ctx)
    await runner(store)("messages_pin", echo as AnyTool, { text: "" }, ctx)

    expect((await store.agentActions.list()).map(({ tier }) => tier).sort()).toEqual(["write-private", "write-public"])
  })

  it("opens its store once for many calls, and again only after it is closed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-log-")), "store.db")
    let opened = 0
    const log = agentLog(() => {
      opened += 1
      return openStore({ path })
    })
    const call = { actor: { bot: "test-mcp" }, tool: "chats_show", tier: "read", status: "ok" } as const

    await Promise.all([1, 2, 3].map(() => log.record({ ...call, startedAt: 1, finishedAt: 2 })))
    await log.record({ ...call, startedAt: 3, finishedAt: 4 })
    expect(opened).toBe(1)

    await log.close()
    await log.record({ ...call, startedAt: 5, finishedAt: 6 })
    await log.close()
    expect(opened).toBe(2)
    const store = await openStore({ path })
    live.push(store)
    expect(await store.agentActions.list()).toHaveLength(5)
  })

  it("reads a tool's tier from what it declares", () => {
    expect(tierOf("messages_delete", { annotations: WRITE })).toBe("destructive")
    expect(tierOf("chats_mark_read", { annotations: WRITE })).toBe("write-private")
    expect(tierOf("messages_unstar", { annotations: WRITE })).toBe("write-private")
    for (const key of ["chats_unmute", "chats_unarchive", "chats_unpin", "chats_mark_unread"])
      expect(tierOf(key, { annotations: WRITE }), key).toBe("write-private")
    expect(tierOf("chats_start", { annotations: WRITE })).toBe("write-public")
    expect(tierOf("messages_pin", { annotations: WRITE })).toBe("write-private")
    expect(tierOf("messages_pin", { annotations: WRITE }, { quietPins: false })).toBe("write-public")
    expect(tierOf("messages_unpin", { annotations: WRITE }, { quietPins: false })).toBe("write-private")
    expect(tierOf("admin_report", { annotations: WRITE })).toBe("admin")
    expect(tierOf("messages_search", { annotations: READ })).toBe("read")
  })
})
