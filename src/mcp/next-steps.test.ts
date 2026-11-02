import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import * as v from "valibot"
import { expect, it } from "vitest"
import { itemOf } from "../cli/envelope.js"
import { registerCommands } from "./index.js"
import { answered } from "./tool.js"

it("keeps a user_action step and drops a command this server does not offer", async () => {
  const server = new McpServer({ name: "chat", version: "0" })
  const action = { kind: "user_action", step: "messages.list", why: "read it in tg", safe_to_auto_execute: false }
  const foreign = {
    kind: "command",
    step: "messages.sync",
    command: "messages sync",
    args: {},
    why: "sync it",
    safe_to_auto_execute: true,
  }
  registerCommands(server, "chat", {
    "projects status": {
      title: "Status",
      description: "where a project stands",
      writes: false,
      input: v.object({}),
      run: async () => answered({ ...itemOf({ id: "2" }), next: [action, foreign] }),
    },
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "fixture", version: "0" })
  await client.connect(clientSide)
  try {
    const result = await client.callTool({ name: "chat_read", arguments: { command: "projects status" } })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { next: unknown[] }).next).toEqual([action])
  } finally {
    await client.close()
  }
})
