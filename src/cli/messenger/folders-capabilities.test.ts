import { describe, expect, it, vi } from "vitest"
import { settingsFor } from "../settings.js"
import { foldersCommand } from "./admin-folders-command.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
describe("folder capability discovery", () => {
  it("omits unsupported operations from CLI and MCP without connecting", () => {
    const connect = vi.fn(async () => {
      throw new Error("discovery must not connect")
    })
    const messenger: Messenger = {
      app,
      provider: "fixture",
      chatArgument: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect,
      folderOrder: false,
      folderJoin: false,
    }
    expect(foldersCommand(messenger).commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "create",
      "update",
      "delete",
    ])
    expect(connect).not.toHaveBeenCalled()
    expect(foldersCommand({ ...messenger, folderOrder: true }).commands.map((command) => command.name())).toContain(
      "order",
    )
    expect(foldersCommand({ ...messenger, folderJoin: true }).commands.map((command) => command.name())).toContain(
      "join",
    )
  })
})
