import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { appMcpCommand } from "../../cli/app-mcp-command.js"
import { commandPermissions } from "../../cli/permission-keys.js"
import { type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import type { Level } from "../../sends/permissions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, exampleLead, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}
const configuration = settingsFor(APP, { permissions: commandPermissions() })
const home = mkdtempSync(join(tmpdir(), "crm-search-denied-"))
const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_CONFIG_DIR: join(home, "config") }

const source = fakeCrmSource()
source.put("deal", exampleDeal("d1", { title: "Example kitchen deal" }))
source.put("lead", exampleLead("l1", { title: "Example kitchen lead" }))

let store: MessageStore

const definition: ProgramDefinition = {
  app: APP,
  configuration,
  commands: () => {
    const root = new Command("crm")
    const open = async (): Promise<CrmRun> => ({
      profile: "work",
      account: { provider: "example-crm", account: "portal" },
      store,
      source: () => source,
    })
    addCrmCommands(root, { app: APP, open })
    return [
      ...root.commands,
      appMcpCommand(APP, configuration, { name: "CRM", untrusted: ["deal titles"], permissionExample: "deals=deny" }),
    ]
  },
}

const levels = (permissions: Record<string, Level>) => {
  mkdirSync(env.CRM_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.CRM_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { work: { permissions } } }))
}

const search = async (...extra: string[]) => {
  const streams = captureStreams()
  const code = await run(["work", "search", "all", "kitchen", "--json", ...extra], definition, {
    streams,
    tty: false,
    env,
  })
  return { code, answer: code === 0 ? JSON.parse(streams.stdout.join("")) : JSON.parse(streams.stderr.join("")) }
}

const kinds = (answer: { items: { kind: string }[] }) => answer.items.map(({ kind }) => kind).sort()

beforeAll(async () => {
  store = await openStore({ path: join(home, "store.db") })
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  levels({})
  expect(await run(["work", "sync", "--json"], definition, { streams: captureStreams(), tty: false, env })).toBe(0)
})
afterAll(() => store.close())

describe("search all leaves out the kinds the profile denies", () => {
  it("reads deals and leads when nothing is denied", async () => {
    levels({})
    const { code, answer } = await search("--only", "crm")
    expect(code).toBe(0)
    expect(kinds(answer)).toEqual(["deal", "lead"])
  })

  it("leaves deals out under deals: deny, and says so in missing", async () => {
    levels({ deals: "deny" })
    const { code, answer } = await search()
    expect(code).toBe(0)
    expect(kinds(answer)).toEqual(["lead"])
    expect(answer.missing).toContainEqual({ field: "items", why: "deal left out: profile work denies deals.list" })
  })

  it("refuses when every kind asked for is denied", async () => {
    levels({ deals: "deny", leads: "deny" })
    const { code, answer } = await search("--only", "crm")
    expect(code).not.toBe(0)
    expect(answer.error).toMatchObject({ code: "permission_error", reason: "search.all-denied" })
  })

  it("leaves deals out of an MCP call under the server's --permission deals=deny", async () => {
    levels({})
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let written = ""
    stdout.on("data", (chunk) => {
      written += chunk
    })
    for (const request of [
      {
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      },
      { method: "notifications/initialized" },
      {
        id: 2,
        method: "tools/call",
        params: { name: "crm_read", arguments: { command: "search all", arguments: { query: ["kitchen"] } } },
      },
    ])
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`)
    stdin.end()
    const code = await run(["work", "mcp", "serve", "--permission", "deals=deny"], definition, {
      streams: captureStreams(),
      tty: false,
      env,
      stdin,
      stdout,
    })
    expect(code).toBe(0)
    const reply = written
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: { content: { text: string }[] } })
      .find((one) => one.id === 2)
    const answer = JSON.parse(reply?.result?.content[0]?.text ?? "null")
    expect(kinds(answer)).toEqual(["lead"])
  })
})
