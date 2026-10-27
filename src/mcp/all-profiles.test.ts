import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { fakeProfileServer } from "../testing/fake-mcp-child.js"
import { freePort, mcpHttpClient } from "../testing/mcp-http-client.js"
import { allProfilesServer, serveAllProfilesOverHttp } from "./all-profiles.js"

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const start = async ({ profiles = ["work", "personal"], idleMs }: { profiles?: string[]; idleMs?: number } = {}) => {
  const { script, log } = fakeProfileServer()
  const served = allProfilesServer({
    command: "chat",
    version: "1",
    name: "Chat",
    profiles: () => profiles,
    child: (profile) => ({ command: process.execPath, args: [script, profile, "mcp"], env: process.env }),
    instructions: "ask which account",
    ...(idleMs ? { idleMs } : {}),
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await served.build().connect(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await served.close()
  })
  const started = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("start "))
  return { client, served, log: () => readFileSync(log, "utf8"), started }
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")

describe("one MCP server for every profile", () => {
  it("shows the profile's tools with a required profile, every profile and no default", async () => {
    const { client } = await start()
    const { tools } = await client.listTools()
    expect(tools.map((one) => one.name)).toEqual(["chat_read"])
    expect(tools[0]?.inputSchema).toMatchObject({
      required: ["profile", "command"],
      properties: { profile: { enum: ["personal", "work"] } },
    })
    expect(JSON.stringify(tools[0]?.inputSchema)).not.toContain('"default"')
    expect(client.getInstructions()).toBe("ask which account")
  })

  it("runs a call in the named profile's own server, without the profile field", async () => {
    const { client, started } = await start()
    const answer = await client.callTool({ name: "chat_read", arguments: { profile: "work", command: "chats list" } })
    expect(textOf(answer)).toEqual({ profile: "work", name: "chat_read", arguments: { command: "chats list" } })
    await client.callTool({ name: "chat_read", arguments: { profile: "work", command: "inbox" } })
    expect(started()).toEqual(["start work mcp"])
  })

  it("refuses a call that names no profile or an unknown one, and starts nothing for it", async () => {
    const { client, started } = await start()
    for (const args of [{ command: "inbox" }, { profile: "stranger", command: "inbox" }]) {
      const answer = await client.callTool({ name: "chat_read", arguments: args })
      expect(answer.isError).toBe(true)
      expect((answer.content as { text: string }[])[0]?.text).toContain("one of: personal, work")
    }
    expect(started()).toEqual([])
  })

  it("closes a profile's server after a quiet spell and starts it again when needed", async () => {
    const { client, log, started } = await start({ idleMs: 50 })
    await client.callTool({ name: "chat_read", arguments: { profile: "personal", command: "inbox" } })
    await expect.poll(log).toContain("end personal mcp")
    await client.callTool({ name: "chat_read", arguments: { profile: "personal", command: "inbox" } })
    expect(started()).toEqual(["start personal mcp", "start personal mcp"])
  })

  it("closes every running profile server when it closes", async () => {
    const { client, served, log } = await start()
    await client.callTool({ name: "chat_read", arguments: { profile: "personal", command: "inbox" } })
    await client.callTool({ name: "chat_read", arguments: { profile: "work", command: "inbox" } })
    await served.close()
    expect(log()).toContain("end personal mcp")
    expect(log()).toContain("end work mcp")
  })

  it("serves every profile over HTTP under the tool's path, behind one login", async () => {
    const { script } = fakeProfileServer()
    const port = await freePort()
    const codes: string[] = []
    const publicUrl = new URL("https://name.test/chat")
    const listening = await serveAllProfilesOverHttp(
      {
        command: "chat",
        version: "1",
        name: "Chat",
        profiles: () => ["personal", "work"],
        child: (profile) => ({ command: process.execPath, args: [script, profile, "mcp"], env: process.env }),
        instructions: "ask which account",
      },
      {
        publicUrl,
        port,
        tokenFile: join(mkdtempSync(join(tmpdir(), "all-http-")), "_all.json"),
        onCode: (code) => codes.push(code),
      },
    )
    const { client } = await mcpHttpClient(listening.url, () => codes.at(-1) ?? "", { publicUrl })
    closers.push(async () => {
      await client.close()
      await listening.close()
    })
    const answer = await client.callTool({ name: "chat_read", arguments: { profile: "personal", command: "inbox" } })
    expect(textOf(answer)).toMatchObject({ profile: "personal" })
  })
})
