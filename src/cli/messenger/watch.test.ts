import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { MessageEvent, MessageHit } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { ConnectOptions, Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { watchCommand } from "./watch-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const hit = (id: string): MessageHit => ({
  id,
  chatId: "7",
  chatTitle: "Book club",
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${id}:00.000Z`,
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const listening =
  (arrive: (MessageHit | MessageEvent)[], asked: ConnectOptions[]) =>
  async (_: unknown, __: unknown, options?: ConnectOptions) => {
    asked.push(options ?? {})
    return {
      self: () => "500",
      close: async () => {},
      watch: async (onEvent: (event: MessageEvent) => void, signal: AbortSignal, onReady?: () => void) => {
        onReady?.()
        for (const event of arrive) onEvent("event" in event ? event : { event: "message", message: event })
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    } as unknown as MessengerAdapter
  }

const call = async (argv: string[], connect: Messenger["connect"], signal?: AbortSignal) => {
  const root = mkdtempSync(join(tmpdir(), "watch-"))
  const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [watchCommand(messenger), messagesCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      ...(signal ? { signal } : {}),
    },
  )
  return { code, streams, env, messenger }
}

describe("watch", () => {
  it("**a signal sent twice — as mtcute does after closing its storage — exits 0 and removes listeners**", async () => {
    const before = process.listenerCount("SIGTERM")
    let during = 0
    const connect = async () =>
      ({
        self: () => "500",
        close: async () => {},
        watch: async (_: unknown, signal: AbortSignal, onReady?: () => void) => {
          onReady?.()
          process.emit("SIGTERM")
          during = process.listenerCount("SIGTERM")
          process.emit("SIGTERM")
          if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
        },
      }) as unknown as MessengerAdapter

    const { code } = await call(["watch", "--jsonl"], connect)
    expect(code).toBe(0)
    expect(during).toBeGreaterThan(before)
    expect(process.listenerCount("SIGTERM")).toBe(before)
  })

  it("**streams each new message as one JSON line, keeps it, and ends normally when stopped**", async () => {
    const asked: ConnectOptions[] = []
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)

    const { code, streams, env } = await call(["watch", "--jsonl"], listening([hit("1"), hit("2")], asked), stop.signal)

    expect(code).toBe(0)
    expect(asked).toEqual([{ listen: true, events: expect.any(Function) }])
    expect(streams.stdout.map((line) => JSON.parse(line).id)).toEqual(["1", "2"])
    const offline = captureStreams()
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: listening([], []),
      chatArgument: "a chat",
    }
    await run(
      ["messages", "list", "7", "--json", "--offline"],
      { app, commands: () => [messagesCommand(messenger)] },
      { streams: offline, tty: false, env },
    )
    expect(JSON.parse(offline.stdout[0] ?? "").items.map((one: { id: string }) => one.id)).toEqual(["1", "2"])
  })

  it("**with --events, names each line's event and keeps every change**", async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    const reactions = { counts: [{ reaction: "👍", count: 3 }], mine: null, total: 3 }
    const arrive: MessageEvent[] = [
      { event: "message", message: hit("1") },
      { event: "message", message: hit("2") },
      { event: "edit", message: { ...hit("1"), text: "message 1, corrected", editedAt: "2026-09-27T11:00:00.000Z" } },
      { event: "delete", chatId: "7", chatTitle: null, messageId: "2" },
      { event: "reaction", chatId: "7", chatTitle: "Book club", messageId: "1", reactions },
    ]

    const { code, streams, env, messenger } = await call(
      ["watch", "--jsonl", "--events"],
      listening(arrive, []),
      stop.signal,
    )

    expect(code).toBe(0)
    expect(streams.stdout.map((line) => JSON.parse(line).event)).toEqual([
      "message",
      "message",
      "edit",
      "delete",
      "reaction",
    ])
    expect(streams.stderr.join("\n")).toContain("listening")
    const offline = captureStreams()
    await run(
      ["messages", "list", "7", "--json", "--offline"],
      { app, commands: () => [messagesCommand(messenger)] },
      { streams: offline, tty: false, env },
    )
    const kept = JSON.parse(offline.stdout[0] ?? "").items
    expect(kept.map((one: MessageHit) => [one.id, one.text, one.reactions?.total])).toEqual([
      ["1", "message 1, corrected", 3],
    ])
  })

  it("prints only messages without --events", async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    const arrive: MessageEvent[] = [
      { event: "message", message: hit("1") },
      { event: "delete", chatId: "7", chatTitle: null, messageId: "1" },
    ]
    const { streams } = await call(["watch", "--jsonl"], listening(arrive, []), stop.signal)
    expect(streams.stdout.map((line) => JSON.parse(line).id)).toEqual(["1"])
  })

  it("ends normally at --timeout", async () => {
    const { code } = await call(["watch", "--jsonl", "--timeout", "30ms"], listening([], []))
    expect(code).toBe(0)
  })

  it("refuses --json, which promises one value, and a messenger that cannot listen", async () => {
    expect((await call(["watch", "--json"], listening([], []))).code).toBe(2)
    const deaf = async () => ({ self: () => "500", close: async () => {} }) as unknown as MessengerAdapter
    expect((await call(["watch", "--jsonl", "--timeout", "30ms"], deaf)).code).toBe(2)
  })
})
