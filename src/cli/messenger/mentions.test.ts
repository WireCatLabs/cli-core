import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { mentionsCommand } from "./mentions-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("mentions never connect")
  },
  chatArgument: "a chat",
}

const message = (id: string, text: string, sent: string): Message => ({
  id,
  chatId: "7",
  senderId: "10",
  senderName: "Alice",
  timestamp: sent,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "mentions-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.saveMessages(
    { provider: "chat", account: "500" },
    "7",
    [
      message("1", "звони 8 (900) 000-00-01", "2026-10-01T10:00:00.000Z"),
      message(
        "2",
        "смета: https://docs.google.com/spreadsheets/d/1SyntheticFileId_abc/edit",
        "2026-10-02T10:00:00.000Z",
      ),
    ],
    { via: "history" },
  )
  await store.close()
  return async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, { app, commands: () => [mentionsCommand(messenger)] }, { streams, tty: false, env })
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
}

describe("mentions", () => {
  it("**lists what the messages mention, shows one in its text, and rebuilds**", async () => {
    const chat = await setup()

    const listed = await chat("mentions", "list", "--json")
    expect(listed.code).toBe(0)
    const page = JSON.parse(listed.stdout)
    expect(page.items.map(({ kind, value }: { kind: string; value: string }) => `${kind} ${value}`)).toEqual([
      "url https://docs.google.com/spreadsheets/d/1SyntheticFileId_abc/edit",
      "document 1SyntheticFileId_abc",
      "phone +79000000001",
    ])
    expect(page.items[2].locator).toBe("msg:chat/500/7/1")
    expect(listed.stderr).toContain("mentions rebuild")

    const phones = JSON.parse((await chat("mentions", "list", "89000000001", "--json")).stdout)
    expect(phones.items.map(({ value }: { value: string }) => value)).toEqual(["+79000000001"])

    const sites = JSON.parse((await chat("mentions", "list", "domain:Docs.Google.com", "kind:url", "--json")).stdout)
    expect(sites.items).toHaveLength(1)

    const phone = page.items[2]
    const shown = JSON.parse((await chat("mentions", "show", String(phone.id), "--json")).stdout)
    expect(shown.item).toMatchObject({ written: "8 (900) 000-00-01", before: "звони ", after: "" })

    const rebuilt = await chat("mentions", "rebuild", "--json")
    expect(rebuilt.code).toBe(0)
    expect(JSON.parse(rebuilt.stdout).item).toEqual({ messages: 2, mentions: 3 })
    expect((await chat("mentions", "list", "--json")).stderr).not.toContain("mentions rebuild")
  })

  it("refuses a kind it does not know and a mention of nothing, and lists its fields in help", async () => {
    const chat = await setup()
    expect((await chat("mentions", "list", "kind:fax")).code).not.toBe(0)
    const help = await chat("mentions", "list", "--help")
    for (const field of ["kind", "status", "domain", "value"]) expect(help.stdout).toContain(field)
    const missing = await chat("mentions", "show", "999", "--json")
    expect(missing.code).not.toBe(0)
    expect(missing.stderr + missing.stdout).toContain("no mention 999")
  })
})
