import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { logRecordSchema } from "@wirecat/cli-base/standards"
import { expectRegisteredEvents } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { MessageEvent, MessageHit } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { defaultRule } from "../../replies/rules.js"
import { NOT_ALLOWED } from "../../replies/serve.js"
import { CORE_LOG_EVENTS } from "../../runs/log-events.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { ConnectOptions, Messenger } from "./context.js"
import { serveCommand } from "./serve-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const hit: MessageHit = {
  id: "1",
  chatId: "7",
  chatTitle: "Book club",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "hello",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "serve-"))
  return {
    root,
    env: { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") },
  }
}

const seen: { lock?: { pid: number; version?: string; listeningAt?: string } } = {}

const call = async (argv: string[], env: NodeJS.ProcessEnv, asked: ConnectOptions[] = [], signal?: AbortSignal) => {
  const connect = async (_: unknown, __: unknown, options?: ConnectOptions) => {
    asked.push(options ?? {})
    return {
      self: () => "500",
      close: async () => {},
      watch: async (onEvent: (event: MessageEvent) => void, stop: AbortSignal, onReady?: () => void) => {
        onReady?.()
        seen.lock = JSON.parse(readFileSync(join(env.CHAT_STATE_DIR ?? "", "serve", "default.lock"), "utf8"))
        onEvent({ event: "message", message: hit })
        onEvent({ event: "delete", chatId: null, chatTitle: null, messageId: "1" })
        await new Promise((resolve) => stop.addEventListener("abort", resolve, { once: true }))
      },
    } as unknown as MessengerAdapter
  }
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
    { app, commands: () => [serveCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      ...(signal ? { signal } : {}),
    },
  )
  return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]).item : undefined, stderr: streams.stderr }
}

const lockOf = (root: string) => join(root, "state", "serve", "default.lock")
const holdLock = (root: string, pid: number) => {
  mkdirSync(join(root, "state", "serve"), { recursive: true })
  writeFileSync(lockOf(root), JSON.stringify({ pid, startedAt: "2026-09-27T09:00:00.000Z" }))
}

describe("serve", () => {
  it("**listens with catch-up, keeps what arrives, and leaves no lock behind**", async () => {
    const { root, env } = setup()
    const asked: ConnectOptions[] = []
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)

    const { code, answer } = await call(["serve", "--json"], env, asked, stop.signal)

    expect(code).toBe(0)
    expect(asked).toEqual([{ listen: true, catchUp: true, events: expect.any(Function), stored: expect.any(Object) }])
    expect(answer).toMatchObject({ profile: "default", kept: { message: 1, delete: 1 } })
    expect(seen.lock).toMatchObject({ pid: process.pid, version: "1.0.0", listeningAt: expect.any(String) })
    expect(existsSync(lockOf(root))).toBe(false)
  })

  it("writes each diagnostic off a terminal as a log record", async () => {
    const { env } = setup()
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)

    const { stderr } = await call(["serve", "--json"], env, [], stop.signal)

    const records = stderr.map((line) => v.parse(logRecordSchema, JSON.parse(line)))
    expect(records).toContainEqual(
      expect.objectContaining({
        severity: "info",
        body: "serve.note",
        attributes: { event: "serve.note", code: "listening" },
      }),
    )
    expectRegisteredEvents(stderr, CORE_LOG_EVENTS)
    expect(stderr.join("\n")).not.toContain("listening for profile")
    expect(records[0]?.resource).toEqual({ service: app.command, version: app.version })
  })

  it("refuses while another serve of the profile is alive, and says which", async () => {
    const { root, env } = setup()
    holdLock(root, process.ppid)

    const { code, stderr } = await call(["serve"], env)
    expect(code).toBe(2)
    expect(stderr.join("\n")).toContain(`PID ${process.ppid}`)
  })

  it("takes over a lock whose process is gone", async () => {
    const { root, env } = setup()
    holdLock(root, 2 ** 22 + 12345)

    const stop = new AbortController()
    setTimeout(() => stop.abort(), 20)
    expect((await call(["serve", "--json"], env, [], stop.signal)).code).toBe(0)
  })
})

describe("serve with reply rules", () => {
  const rulesFor = (env: NodeJS.ProcessEnv, permissions?: object) => {
    const config = env.CHAT_CONFIG_DIR ?? ""
    mkdirSync(config, { recursive: true })
    const rule = {
      ...defaultRule("away"),
      on: true,
      reply: { template: "Back soon.", model: "fill-only", asReply: false },
    }
    writeFileSync(
      join(config, "default.replies.json"),
      JSON.stringify({ audience: { reply: "listed", allow: { people: ["77"] } }, rules: [rule] }),
    )
    if (permissions)
      writeFileSync(join(config, "config.json"), JSON.stringify({ profiles: { default: { permissions } } }))
  }

  const serving = async (env: NodeJS.ProcessEnv) => {
    rememberAccount(app, "default", "500", env)
    const sent: { chatId: string; text: string }[] = []
    const now = new Date(Date.now() + 1000).toISOString()
    const connect = async () =>
      ({
        self: () => "500",
        close: async () => {},
        resolve: async (id: string) => ({ id, title: "Test", kind: "dialog" }),
        send: async (chatId: string, text: string, options: { sendId: string }) => {
          if (chatId !== "77") throw new Error("a rule wrote to someone who is not a test account")
          sent.push({ chatId, text })
          return { message: { ...hit, id: "99", chatId, text, outgoing: true }, sendId: options.sendId }
        },
        watch: async (onEvent: (event: MessageEvent) => void, stop: AbortSignal, onReady?: () => void) => {
          onReady?.()
          onEvent({ event: "message", message: { ...hit, id: "1", chatId: "9", senderId: "9", timestamp: now } })
          onEvent({ event: "message", message: { ...hit, id: "2", chatId: "77", senderId: "77", timestamp: now } })
          await new Promise((resolve) => stop.addEventListener("abort", resolve, { once: true }))
        },
      }) as unknown as MessengerAdapter
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect,
      chatArgument: "a chat",
    }
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    const streams = captureStreams()
    await run(
      ["serve", "--json"],
      { app, commands: () => [serveCommand(messenger)] },
      {
        streams,
        tty: false,
        env,
        signal: stop.signal,
      },
    )
    return { sent, answer: JSON.parse(streams.stdout[0] ?? "{}").item }
  }

  it("**answers only the allowed person, and the send journal names the rule**", async () => {
    const { root, env } = setup()
    const withConfig = { ...env, CHAT_CONFIG_DIR: join(root, "config") }
    rulesFor(withConfig, { "replies.send": "allow" })

    const { sent, answer } = await serving(withConfig)

    expect(sent).toEqual([{ chatId: "77", text: "Back soon." }])
    expect(answer.replies).toEqual({ sent: { away: 1 }, skipped: { "not on the allow list": 1 } })
    const [entry] = new SendJournal(sendsPathFor(app, "default", withConfig))
      .entries()
      .filter((one) => one.outcome === "sent")
    expect(entry).toMatchObject({ chatId: "77", origin: "rule:away" })
  })

  it("sends nothing while replies.send is not allow", async () => {
    const { root, env } = setup()
    const withConfig = { ...env, CHAT_CONFIG_DIR: join(root, "config") }
    rulesFor(withConfig)

    const { sent, answer } = await serving(withConfig)

    expect(sent).toEqual([])
    expect(answer.replies.skipped).toMatchObject({ [NOT_ALLOWED]: 1 })
  })
})
