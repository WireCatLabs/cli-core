import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { fakeAdapter } from "../../kit/fake.js"
import { contractSeed } from "../../kit/seed.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { chatsCommand } from "./chats-command.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { COMMAND_NEEDS } from "./lacks.js"
import { messagesCommand } from "./messages-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1" }
const seed = contractSeed()
const chat = seed.chats[0]?.id ?? ""
const message = seed.messages[0]?.id ?? ""
const person = seed.person

const argvOf = (root: string): Record<string, string[]> => {
  const book = join(root, "book.txt")
  writeFileSync(book, "+34600000000, Ana\n")
  return {
    "account update": ["--first-name", "Ana"],
    "account sessions list": [],
    "account sessions end": ["--others"],
    "chats events": [chat],
    "chats inspect": ["https://example.test/join/x"],
    "chats folders list": [],
    "chats folders show": ["1"],
    "chats folders create": ["Work"],
    "chats folders update": ["1", "--title", "Home"],
    "chats folders delete": ["1"],
    "contacts add": [person],
    "contacts remove": [person],
    "contacts rename": [person, "Ana"],
    "contacts import": [book],
    "messages comments": [chat, message],
    "messages pin": [chat, message],
    "messages unpin": [chat, message],
  }
}

const cli = async (path: string, own: Partial<Messenger>, adapter: () => MessengerAdapter) => {
  const root = mkdtempSync(join(tmpdir(), "lacks-"))
  const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
  const connects: number[] = []
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    chatArgument: "a chat",
    connect: async () => {
      connects.push(1)
      return adapter()
    },
    ...own,
  }
  const streams = captureStreams()
  const code = await run(
    [...path.split(" "), ...(argvOf(root)[path] ?? []), "--json"],
    {
      app,
      commands: () => [
        accountCommand(messenger),
        chatsCommand(messenger),
        contactsCommand(messenger),
        messagesCommand(messenger),
      ],
    },
    { streams, tty: false, env },
  )
  const error = JSON.parse(streams.stderr.at(-1) ?? "null")?.error
  return { code, connects, message: error?.message as string | undefined }
}

describe("a command whose one method the messenger lacks", () => {
  it("refuses comments from a messenger that declares them unsupported before connecting", async () => {
    const result = await cli("messages comments", { channelComments: false }, () => fakeAdapter(seed))
    expect(result).toMatchObject({
      code: 2,
      connects: [],
      message: "this messenger cannot read comments on a channel post",
    })
  })

  for (const [path, [method, what]] of Object.entries(COMMAND_NEEDS)) {
    it(`${path} refuses before connecting, as the adapter would after`, async () => {
      const without = () => {
        const adapter = fakeAdapter(seed) as unknown as Record<string, unknown>
        delete adapter[method]
        return adapter as unknown as MessengerAdapter
      }

      const early = await cli(path, { lacks: [method] }, without)
      const late = await cli(path, {}, without)

      expect(early).toMatchObject({ code: 2, connects: [], message: `this messenger cannot ${what}` })
      expect(late).toMatchObject({ connects: [1], message: early.message })
    })
  }
})
