import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { settingsFor } from "../cli/settings.js"
import { personalMcpTools } from "./personal.js"
import { registerPrompts } from "./prompts.js"
import { inputOf } from "./tool.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  chatArgument: "a chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("no connection in this test")
  },
}

const SAMPLES: Record<string, string[]> = {
  kind: ["group"],
  mode: ["unread", "new", "2h", "2026-10-01T09:00:00Z"],
  chat: ["Book club"],
  since: ["1d ago", "2026-10-01T09:00:00Z"],
  groups: ["Work"],
  text: ["invoice"],
}

/** Every `{ … }` that follows `chat_read with` or `chat_write with` in a prompt's text. */
const callsIn = (text: string): { command: string; arguments?: Record<string, unknown> }[] =>
  [...text.matchAll(/chat_(?:read|write) with \{/g)].map((match) => {
    const start = (match.index ?? 0) + match[0].length - 1
    let depth = 0
    let quoted = false
    for (let at = start; at < text.length; at += 1) {
      const char = text[at]
      if (quoted) {
        if (char === "\\") at += 1
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === "{") depth += 1
      else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, at + 1))
    }
    throw new Error(`unbalanced call in: ${text.slice(start)}`)
  })

const promptTexts = async () => {
  const server = new McpServer({ name: "chat", version: "1.0.0" })
  registerPrompts(server, { command: "chat", name: "Chat" })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  const texts: { prompt: string; text: string }[] = []
  for (const prompt of (await client.listPrompts()).prompts) {
    const names = (prompt.arguments ?? []).map((one) => one.name)
    const variants = Math.max(1, ...names.map((name) => SAMPLES[name]?.length ?? 1))
    for (let at = 0; at < variants; at += 1) {
      const args = Object.fromEntries(
        names.map((name) => {
          const samples = SAMPLES[name] ?? ["x"]
          return [name, samples[at % samples.length] ?? "x"]
        }),
      )
      for (const asked of [args, {}]) {
        const required = (prompt.arguments ?? []).filter((one) => one.required).map((one) => one.name)
        if (required.some((name) => !(name in asked))) continue
        const [first] = (await client.getPrompt({ name: prompt.name, arguments: asked })).messages
        texts.push({ prompt: prompt.name, text: first?.content.type === "text" ? first.content.text : "" })
      }
    }
  }
  await client.close()
  return texts
}

describe("MCP prompts", () => {
  it("name only commands and arguments the tools take", async () => {
    const tools = personalMcpTools(messenger)
    const refused: string[] = []
    let seen = 0
    for (const { prompt, text } of await promptTexts()) {
      for (const call of callsIn(text)) {
        seen += 1
        const tool = tools[call.command.replaceAll(" ", "_").replaceAll("-", "_")]
        if (!tool) {
          refused.push(`${prompt}: no tool for "${call.command}"`)
          continue
        }
        const accepted = Object.keys(inputOf(tool, true).entries)
        for (const name of Object.keys(call.arguments ?? {}))
          if (!accepted.includes(name)) refused.push(`${prompt}: ${call.command} takes no ${name}`)
      }
    }
    expect(seen).toBeGreaterThan(10)
    expect(refused).toEqual([])
  })

  it("asks review for its window as a query, never with since", async () => {
    const review = (await promptTexts()).filter(({ prompt }) => prompt === "review")
    const calls = review.flatMap(({ text }) => callsIn(text)).filter((call) => call.command === "review")
    expect(calls).toContainEqual({ command: "review", arguments: { query: 'date>"1d ago"' } })
    expect(calls).toContainEqual({ command: "review", arguments: { query: 'date>"2026-10-01T09:00:00Z"' } })
    expect(calls.some((call) => call.arguments !== undefined && "since" in call.arguments)).toBe(false)
  })
})
