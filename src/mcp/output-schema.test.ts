import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { toJsonSchema } from "@valibot/to-json-schema"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { answerSchema, itemOf } from "../cli/envelope.js"
import { ENTITIES } from "../entities/index.js"
import { outputOf, registerCommands } from "./surface.js"
import { answered } from "./tool.js"

const searched = async (output?: v.GenericSchema) => {
  const server = new McpServer({ name: "chat", version: "0" })
  registerCommands(server, "chat", {
    "chats show": {
      title: "Show a chat",
      description: "one chat",
      writes: false,
      input: v.object({}),
      ...(output ? { output } : {}),
      run: async () => answered(itemOf({ id: "2" })),
    },
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "fixture", version: "0" })
  await client.connect(clientSide)
  try {
    const found = await client.callTool({ name: "chat_tools_search", arguments: { query: "chats show" } })
    return (found.structuredContent as { items: { output: unknown }[] }).items[0]?.output
  } finally {
    await client.close()
  }
}

describe("the answer a command declares", () => {
  it("is its entity's envelope, a list or one item, which tools_search shows", async () => {
    const declared = outputOf({ entity: "chat" })

    expect(toJsonSchema(declared)).toEqual(toJsonSchema(answerSchema(ENTITIES.chat)))
    expect(await searched(declared)).toEqual(toJsonSchema(answerSchema(ENTITIES.chat)))
  })

  it("is any envelope for a command that declares none", async () => {
    expect(await searched()).toEqual(toJsonSchema(answerSchema()))
  })
})
