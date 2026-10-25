import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import { type LinkBatch, openStore } from "../../store/store.js"
import { configCommand } from "../config-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { conversationsCommand } from "./conversations-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const config = settingsFor(app)
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: config.resolveSettings,
  chatArgument: "chat",
  connect: async () => {
    throw new Error("analysis never connects to messenger")
  },
}
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})
const setup = async () => {
  let calls = 0
  const server = createServer(async (request, response) => {
    let input = ""
    for await (const chunk of request) input += chunk
    const body = JSON.parse(input) as { model: string; messages: { content: string }[] }
    const batch = JSON.parse(body.messages[1]?.content ?? "{}") as LinkBatch
    calls++
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                model: body.model,
                skill: "1",
                answers: batch.messages
                  .filter((message) => message.answer)
                  .map((message) => ({ message: message.id, parent: null, confidence: 0.8 })),
              }),
            },
          },
        ],
        usage: { total_tokens: 100 },
      }),
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const root = mkdtempSync(join(tmpdir(), "analysis-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CHAT_OPENAI_API_KEY: "",
    CHAT_ANTHROPIC_API_KEY: "",
    NO_COLOR: "1",
  }
  mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
  const configure = (extra = {}, analysis = {}) =>
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({
        profiles: {
          default: {
            models: { analysis: { provider: "openai", model: "test-model", base_url: baseUrl, ...analysis } },
            ...extra,
          },
        },
      }),
    )
  configure()
  rememberAccount(app, "default", "500", env)
  const add = async (chat = "9", id = "1") => {
    const store = await openStore({ path: env.MESSAGING_STORE })
    const account = { provider: "chat", account: "500" }
    await store.chats.saveChats(account, [
      { id: chat, title: `Group ${chat}`, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(
      account,
      chat,
      [
        {
          id,
          chatId: chat,
          senderId: id,
          senderName: null,
          timestamp: `2026-10-01T00:0${id}:00Z`,
          editedAt: null,
          text: "synthetic context",
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        } satisfies Message,
      ],
      { via: "history" },
    )
    await store.close()
  }
  await add()
  const keyring = memoryKeyring()
  const callWith = async (extra: NodeJS.ProcessEnv, argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { app, commands: () => [conversationsCommand(messenger), configCommand(app, config)] },
      { streams, tty: false, env: { ...env, ...extra }, keyring },
    )
    if (code === 0 && argv[0] === "conversations" && argv[1] === "build" && argv.includes("--json"))
      v.parse(ENTITIES.conversation_build, JSON.parse(streams.stdout[0] ?? "null").item)
    return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
  }
  const call = (...argv: string[]) => callWith({}, argv)
  const locked = (...argv: string[]) => callWith({ CHAT_READ_ONLY: "1" }, argv)
  return { call, locked, add, calls: () => calls, configure, baseUrl }
}
const json = (result: { stdout: string[] }) => {
  const body = JSON.parse(result.stdout[0] ?? "null")
  return body?.item ?? body
}

describe("analysis CLI consent and configuration", () => {
  it("asks once per chat/provider, remembers explicit yes, and asks again after revocation", async () => {
    const { call, add, calls, baseUrl } = await setup()
    expect((await call("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--json")).code).not.toBe(0)
    expect(calls()).toBe(0)
    const first = await call(
      "conversations",
      "links",
      "rebuild",
      "--analyze",
      "--analysis-provider",
      "openai",
      "--chat",
      "9",
      "--yes",
      "--json",
    )
    expect(first.code, JSON.stringify(first)).toBe(0)
    expect(json(first)).toMatchObject({ stored: 1, stopped: "complete" })
    expect(calls()).toBe(1)
    await add("9", "2")
    expect((await call("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--json")).code).toBe(0)
    expect(calls()).toBe(2)
    expect(json(await call("conversations", "consents", "list", "--json")).items).toMatchObject([
      { chat: "9", provider: `openai:${baseUrl}` },
    ])
    const selected = json(await call("conversations", "consents", "list", "chat:9", "--json"))
    expect(selected.items).toHaveLength(1)
    expect(v.safeParse(ENTITIES.analysis_consent, selected.items[0]).success).toBe(true)
    const projected = await call(
      "conversations",
      "consents",
      "list",
      `provider:"openai:${baseUrl}"`,
      "--json=chat,provider",
    )
    expect(projected.code).toBe(0)
    expect(json(projected).items).toEqual([{ chat: "9", provider: `openai:${baseUrl}` }])
    expect(json(await call("conversations", "consents", "list", "chat:10", "--json")).items).toEqual([])
    const unsupported = await call("conversations", "consents", "list", "at>=7d", "--json")
    expect(unsupported.code).toBe(2)
    expect(unsupported.stderr).toContain("query.unsupported-field")
    expect(calls()).toBe(2)
    await add("10")
    expect((await call("conversations", "links", "rebuild", "--analyze", "--chat", "10", "--json")).code).not.toBe(0)
    await add("9", "3")
    expect(
      (
        await call(
          "conversations",
          "links",
          "rebuild",
          "--analyze",
          "--chat",
          "9",
          "--base-url",
          `${baseUrl}/other`,
          "--model",
          "test-model",
          "--json",
        )
      ).code,
    ).not.toBe(0)
    expect(calls()).toBe(2)
    expect(
      (
        await call(
          "conversations",
          "consents",
          "remove",
          "--chat",
          "9",
          "--consent-provider",
          `openai:${baseUrl}`,
          "--json",
        )
      ).code,
    ).toBe(0)
    expect((await call("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--json")).code).not.toBe(0)
    expect(calls()).toBe(2)
    expect(json(await call("conversations", "consents", "list", "--json")).items).toEqual([])
  })
  it("defaults to owner-agent analysis, requires a chat, enforces write permission and token budget", async () => {
    const { call, configure, calls } = await setup()
    expect((await call("conversations", "links", "rebuild", "--analyze", "--yes", "--json")).code).not.toBe(0)
    expect(
      (await call("conversations", "links", "rebuild", "--chat", "9", "--model", "test-model", "--json")).code,
    ).not.toBe(0)
    configure({}, { provider: "off" })
    expect(
      (await call("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--yes", "--json")).code,
    ).not.toBe(0)
    configure({ permissions: { "conversations.links": "readonly" } })
    expect(
      (await call("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--yes", "--json")).code,
    ).not.toBe(0)
    expect((await call("conversations", "consents", "remove", "--json")).code).not.toBe(0)
    configure()
    const capped = await call(
      "conversations",
      "links",
      "rebuild",
      "--analyze",
      "--chat",
      "9",
      "--yes",
      "--max-tokens",
      "100",
      "--json",
    )
    expect(capped.code, JSON.stringify(capped)).toBe(0)
    expect(json(capped)).toMatchObject({ stopped: "budget", stored: 0 })
    expect(calls()).toBe(0)
    const shown = json(await call("config", "show", "--json"))
    expect(shown.settings).toContainEqual(
      expect.objectContaining({
        setting: "models",
        value: { analysis: expect.objectContaining({ provider: "openai" }) },
      }),
    )
  })
  it("under the read-only lock sends nothing to a remote provider, and still analyzes on a local server", async () => {
    const { call, locked, configure, calls } = await setup()
    configure({}, { base_url: "https://analysis.example.com/v1" })
    const refused = await locked("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--yes", "--json")
    expect(refused.code).toBe(5)
    expect(JSON.parse(refused.stderr).error.message).toBe(
      "this process is read-only (CHAT_READ_ONLY) — it cannot send chat text to analysis.example.com",
    )
    expect(json(await call("conversations", "consents", "list", "--json")).items).toEqual([])
    configure()
    expect(
      (await locked("conversations", "links", "rebuild", "--analyze", "--chat", "9", "--yes", "--json")).code,
    ).toBe(0)
    expect(calls()).toBe(1)
  })
})
