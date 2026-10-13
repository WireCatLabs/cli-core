import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { toJsonSchema } from "@valibot/to-json-schema"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { itemOf, listOf } from "../cli/envelope.js"
import type { Messenger } from "../cli/messenger/context.js"
import { settingsFor } from "../cli/settings.js"
import { ENTITIES } from "../entities/index.js"
import { READ, type Registration, registerTools, tool } from "./tool.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const at = "2026-10-13T10:00:00.000Z"
const chat = {
  ref: "chat:telegram/1/2",
  id: "2",
  title: "Synthetic",
  kind: "group",
  unread_count: null,
  last_message_at: at,
  participants_count: null,
}

const tools = {
  chats_show: tool({
    title: "Show a chat",
    description: "one chat",
    input: v.strictObject({}),
    annotations: READ,
    output: { entity: "chat", list: false },
    local: async () => itemOf(chat),
  }),
  chats_list: tool({
    title: "List chats",
    description: "chats",
    input: v.strictObject({}),
    annotations: READ,
    output: { entity: "chat", list: true },
    local: async () => listOf("chats list", { items: [chat], limit: 20, has_more: false }),
  }),
  account_show: tool({
    title: "Show the account",
    description: "who this is",
    input: v.strictObject({}),
    annotations: READ,
    local: async () => ({ id: "1" }),
  }),
}

const connected = async () => {
  const messenger = {
    app,
    provider: "chat",
    chatArgument: "a chat",
    resolveSettings: settingsFor(app).resolveSettings,
  } as unknown as Messenger
  const registration: Registration = {
    command: "chat",
    messenger,
    session: { use: async () => Promise.reject(new Error("no connection in this test")) },
    withStore: async () => Promise.reject(new Error("no store in this test")),
    defaults: {
      limit: 20,
      guard: { check: () => {}, record: () => {} },
      env: process.env,
      settings: { profile: "default", configured: {}, shared: {} },
      history: false,
    },
  }
  const server = new McpServer({ name: "chat", version: "0" })
  registerTools(server, tools, registration)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "fixture", version: "0" })
  await client.connect(clientSide)
  return client
}

describe("MCP answers in the envelope", () => {
  it("lists tools in name order, each answering one generates its outputSchema from the entity", async () => {
    const client = await connected()
    try {
      const { tools: listed } = await client.listTools()
      expect(listed.map((one) => one.name)).toEqual(["chat_account_show", "chat_chats_list", "chat_chats_show"])
      const schema = (name: string) => listed.find((one) => one.name === name)?.outputSchema
      expect(schema("chat_chats_show")).toEqual(
        toJsonSchema(itemEnvelopeSchema(ENTITIES.chat), { target: "draft-2020-12" }),
      )
      expect(schema("chat_chats_list")).toEqual(
        toJsonSchema(listEnvelopeSchema(ENTITIES.chat), { target: "draft-2020-12" }),
      )
      expect(JSON.stringify(schema("chat_chats_list"))).not.toMatch(/"\$ref":"https?:/)
    } finally {
      await client.close()
    }
  })

  it("gives structuredContent the envelope with its meta, checked against that schema", async () => {
    const client = await connected()
    try {
      const shown = await client.callTool({ name: "chat_chats_show", arguments: {} })
      expect(shown.isError).toBeFalsy()
      expect(shown.structuredContent).toMatchObject({ item: chat, meta: { run_id: expect.any(String) } })
      const listed = await client.callTool({ name: "chat_chats_list", arguments: {} })
      expect(listed.structuredContent).toMatchObject({ items: [chat], page: { limit: 20, has_more: false } })
    } finally {
      await client.close()
    }
  })
})
