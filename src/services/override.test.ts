import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { messagesCommand } from "../cli/messenger/messages-command.js"
import { run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import type { Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { Override } from "./index.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const message: Message = {
  id: "1",
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "chapter one",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const adapter = {
  self: () => "500",
  history: async () => ({ items: [message], hasMore: false }),
  close: async () => {},
} as unknown as MessengerAdapter

const shouting: Override = (base) => ({
  messages: {
    ...base.messages,
    list: async (chat, window) => {
      const page = await base.messages.list(chat, window)
      return { ...page, items: page.items.map((one) => ({ ...one, text: one.text.toUpperCase() })) }
    },
  },
})

const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => adapter,
  chatArgument: "a chat",
  services: shouting,
}

describe("a messenger's override", () => {
  it("replaces one method for the commands, with the shared one inside", async () => {
    const root = mkdtempSync(join(tmpdir(), "override-"))
    const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
    const streams = captureStreams()
    const code = await run(
      ["messages", "list", "7", "--json"],
      { app, commands: () => [messagesCommand(messenger)] },
      {
        streams,
        tty: false,
        env,
      },
    )

    expect(code).toBe(0)
    expect(JSON.parse(streams.stdout.join("")).items[0].text).toBe("CHAPTER ONE")
  })
})
