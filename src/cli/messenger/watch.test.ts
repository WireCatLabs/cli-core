import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { jsonlEndSchema, jsonlItemSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import type { MessageEvent, MessageHit } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { ConnectOptions, Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { watchCommand } from "./watch-command.js"

const itemsOf = (lines: string[], complete = true) => {
  const records = lines.map((line) => JSON.parse(line))
  expect(records.filter((record) => record.type === "end")).toHaveLength(1)
  expect(v.parse(jsonlEndSchema, records.at(-1)).complete).toBe(complete)
  return records.slice(0, -1).map((record) => {
    v.parse(jsonlItemSchema(ENTITIES.watch_item), record)
    return record.data
  })
}

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

const call = async (argv: string[], connect: Messenger["connect"], signal?: AbortSignal, realStreams = false) => {
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
      ...(realStreams ? {} : { streams }),
      tty: false,
      env,
      ...(signal ? { signal } : {}),
    },
  )
  return { code, streams, env, messenger }
}

describe("watch", () => {
  it("retains live observations and explicit false stars in the canonical message view", async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    const observed = "2026-09-27T12:00:00.000Z"
    const { code, streams } = await call(
      ["watch", "--jsonl"],
      listening(
        [
          {
            ...hit("1"),
            starred: false,
            counterObservations: { views: { value: 12, observedAt: observed, source: "remote_update" } },
          },
        ],
        [],
      ),
      stop.signal,
    )
    expect(code).toBe(0)
    expect(itemsOf(streams.stdout)).toMatchObject([
      {
        ref: "msg:chat/500/7/1",
        chat_id: "7",
        starred: false,
        counter_observations: { views: { value: 12, observed_at: observed, source: "remote_update" } },
      },
    ])
    expect(itemsOf(streams.stdout)[0]).not.toHaveProperty("chatId")
  })

  it("frames every supported event with its declared snake_case payload", async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 30)
    const at = "2026-09-27T12:00:00.000Z"
    const person = { id: "9", name: "Olga", username: null }
    const arrive: MessageEvent[] = [
      {
        event: "message",
        message: {
          ...hit("1"),
          attachments: [
            {
              kind: "poll",
              poll: {
                chatId: "7",
                messageId: "1",
                question: "Synthetic?",
                answers: [{ id: "a", text: "One", voters: 0, chosen: false }],
                closed: false,
                multiple: false,
                anonymous: false,
                voters: 0,
              },
            },
          ],
        },
      },
      { event: "vote", chatId: "7", chatTitle: null, messageId: "1", vote: { person, answers: ["a"], votedAt: at } },
      {
        event: "person_reaction",
        chatId: "7",
        chatTitle: null,
        messageId: "1",
        reaction: { person, own: false, reaction: "👍", reactedAt: at },
      },
      { event: "star", chatId: "7", chatTitle: null, messageId: "1", starred: false },
      { event: "delivery", chatId: "7", chatTitle: null, messageId: "1", delivery: "read", at },
      {
        event: "chat_event",
        chatId: "7",
        chatTitle: null,
        change: {
          messageId: "2",
          timestamp: at,
          event: "promote",
          by: { id: "500", name: "Alice" },
          people: [{ id: "9", name: "Olga" }],
        },
      },
      { event: "delete", chatId: null, chatTitle: null, messageId: "3" },
    ]
    const { code, streams } = await call(["watch", "--jsonl", "--events"], listening(arrive, []), stop.signal)
    expect(code, streams.stderr.join(" ")).toBe(0)
    const items = itemsOf(streams.stdout)
    expect(items.map((one) => one.event)).toEqual(arrive.map((one) => one.event))
    expect(items[1].vote).toMatchObject({ person_id: "9", voted_at: at })
    expect(items[2].reaction).toMatchObject({ reacted_at: at })
    expect(items[5].change).toMatchObject({ type: "promote", time: at })
  })

  it.each([false, true])(
    "ends an interrupted source once, marking failure without exposing its text (%s)",
    async (known) => {
      const connect = async () =>
        ({
          self: () => "500",
          close: async () => {},
          watch: async (arrived: (event: MessageEvent) => void) => {
            arrived({ event: "message", message: hit("1") })
            throw known
              ? new CliError("network_error", "synthetic source stopped")
              : new Error("synthetic private provider payload")
          },
        }) as unknown as MessengerAdapter
      const { code, streams } = await call(["watch", "--jsonl"], connect)
      expect(code).not.toBe(0)
      expect(itemsOf(streams.stdout, false)).toHaveLength(1)
      const end = JSON.parse(streams.stdout.at(-1) ?? "null")
      if (known) expect(end.issues).toEqual([{ code: "network_error", source: "watch" }])
      else {
        expect(end.issues).toBeUndefined()
        expect(streams.stderr.join(" ")).toContain("internal_error")
        expect(streams.stderr.join(" ")).toContain("command.crashed")
      }
      expect(streams.stdout.join("") + streams.stderr.join("")).not.toContain("synthetic private provider payload")
    },
  )

  it("does not write a terminal record into a reader's closed pipe", async () => {
    const stdout: string[] = []
    let during = 0
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk).trimEnd())
      return true
    })
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const connect = async () =>
        ({
          self: () => "500",
          close: async () => {},
          watch: async (arrived: (event: MessageEvent) => void) => {
            arrived({ event: "message", message: hit("1") })
            during = process.stdout.listenerCount("error")
            process.stdout.emit("error", Object.assign(new Error("reader closed"), { code: "EPIPE" }))
          },
        }) as unknown as MessengerAdapter
      const { code } = await call(["watch", "--jsonl"], connect, undefined, true)
      expect(code).toBe(0)
      expect(stdout).toHaveLength(1)
      v.parse(jsonlItemSchema(ENTITIES.watch_item), JSON.parse(stdout[0] ?? "null"))
      expect(process.stdout.listenerCount("error")).toBe(during - 1)
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  })

  it("ends the stream complete after a normal SIGTERM", async () => {
    const connect = async () =>
      ({
        self: () => "500",
        close: async () => {},
        watch: async (arrived: (event: MessageEvent) => void) => {
          arrived({ event: "message", message: hit("1") })
          process.emit("SIGTERM")
        },
      }) as unknown as MessengerAdapter
    const { code, streams } = await call(["watch", "--jsonl"], connect)
    expect(code).toBe(0)
    expect(itemsOf(streams.stdout)).toHaveLength(1)
  })

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
    expect(asked).toEqual([{ listen: true, events: expect.any(Function), stored: expect.any(Object) }])
    expect(itemsOf(streams.stdout).map((one) => one.id)).toEqual(["1", "2"])
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
    expect(itemsOf(streams.stdout).map((one) => one.event)).toEqual([
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

  it("**SEC-54: no output carries an attachment's providerRef — watch, --events, stored reads or run logs**", async () => {
    const SECRET = "media-key-LEAK-SENTINEL"
    const keyed = (id: string): MessageHit => ({
      ...hit(id),
      attachments: [{ kind: "photo", name: "a.jpg", providerRef: { directPath: "/v/t62", mediaKey: SECRET } }],
      replyTo: {
        id: "0",
        senderId: "9",
        senderName: "Olga",
        timestamp: null,
        text: "",
        outgoing: false,
        attachments: [{ kind: "photo", providerRef: { mediaKey: SECRET } }],
      },
    })
    const arrive: MessageEvent[] = [
      { event: "message", message: keyed("1") },
      { event: "edit", message: { ...keyed("1"), text: "edited", editedAt: "2026-09-27T11:00:00.000Z" } },
    ]
    const outputs: string[] = []
    let env: Record<string, string> = {}
    let messenger: Messenger | undefined
    for (const argv of [["watch", "--jsonl"], ["watch", "--jsonl", "--events"], ["watch"]]) {
      const stop = new AbortController()
      setTimeout(() => stop.abort(), 20)
      const done = await call(argv, listening(arrive, []), stop.signal)
      outputs.push(...done.streams.stdout, ...done.streams.stderr)
      env = done.env
      messenger = done.messenger
    }
    expect(outputs.join("\n")).toContain("edited")
    for (const argv of [
      ["messages", "list", "7", "--json", "--offline"],
      ["messages", "list", "7", "--jsonl", "--offline"],
      ["messages", "list", "7", "--offline", "-vv"],
    ]) {
      const streams = captureStreams()
      await run(argv, { app, commands: () => [messagesCommand(messenger as Messenger)] }, { streams, tty: false, env })
      outputs.push(...streams.stdout, ...streams.stderr)
    }
    expect(outputs.join("\n")).not.toContain(SECRET)
    expect(outputs.join("\n")).not.toMatch(/provider_?ref/i)
    const logs = readdirSync(env.CHAT_STATE_DIR ?? "", { recursive: true, withFileTypes: true })
      .filter((one) => one.isFile())
      .map((one) => readFileSync(join(one.parentPath, one.name), "utf8"))
    expect(logs.join("\n")).not.toContain(SECRET)
  })

  it("**DEBT-126: hands connect a lookup of the stored messages, over the command's own store**", async () => {
    const asked: ConnectOptions[] = []
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    const { env, messenger } = await call(["watch", "--jsonl"], listening([hit("1"), hit("2")], asked), stop.signal)
    const looked: unknown[] = []
    const lookingUp: Messenger["connect"] = async (command, base, options) => {
      const adapter = await listening([], asked)(command, base, options)
      return {
        ...adapter,
        resolve: async () => ({ id: "7", title: "Book club", kind: "group" }),
        send: async () => {
          const stored = options?.stored
          looked.push(
            (await stored?.message("7", "1"))?.text,
            (await stored?.message("7", "missing")) ?? null,
            (await stored?.newestIncoming("7"))?.id,
            (await stored?.newestIncoming("7", "2"))?.id,
          )
          return { message: hit("4"), sendId: "x" }
        },
      } as unknown as MessengerAdapter
    }
    const streams = captureStreams()
    await run(
      ["messages", "send", "7", "hi", "--json"],
      { app, commands: () => [messagesCommand({ ...messenger, connect: lookingUp })] },
      { streams, tty: false, env },
    )
    expect(streams.stderr.join("\n")).toBe("")
    expect(looked).toEqual(["message 1", null, "2", "1"])
  })

  it("prints only messages without --events", async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    const arrive: MessageEvent[] = [
      { event: "message", message: hit("1") },
      { event: "delete", chatId: "7", chatTitle: null, messageId: "1" },
    ]
    const { streams } = await call(["watch", "--jsonl"], listening(arrive, []), stop.signal)
    expect(itemsOf(streams.stdout).map((one) => one.id)).toEqual(["1"])
  })

  it("ends normally at --timeout", async () => {
    const { code, streams } = await call(["watch", "--jsonl", "--timeout", "30ms"], listening([], []))
    expect(code).toBe(0)
    expect(itemsOf(streams.stdout)).toEqual([])
  })

  it("does not claim completion after the output cap refuses a message", async () => {
    const { code, streams } = await call(["watch", "--jsonl", "--max-output-bytes", "1"], listening([hit("1")], []))
    expect(code).toBe(13)
    expect(streams.stdout).toEqual([])
    expect(streams.stderr.join(" ")).toContain("output.too-large")
  })

  it("refuses --json, which promises one value, and a messenger that cannot listen", async () => {
    expect((await call(["watch", "--json"], listening([], []))).code).toBe(2)
    const deaf = async () => ({ self: () => "500", close: async () => {} }) as unknown as MessengerAdapter
    expect((await call(["watch", "--jsonl", "--timeout", "30ms"], deaf)).code).toBe(2)
  })
})
