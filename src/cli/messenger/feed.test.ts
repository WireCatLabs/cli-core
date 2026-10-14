import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { contractSeed, fakeAdapter } from "../../kit/index.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import type { MessengerAdapter } from "./port.js"
import { serveCommand } from "./serve-command.js"
import { watchCommand } from "./watch-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const seed = contractSeed()

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "feed-"))
  return {
    root,
    env: {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
    } as NodeJS.ProcessEnv,
  }
}

/** The fake that pushes its history, stopping the command once the push is handed over. */
const pushing = (stop: AbortController, change: Partial<MessengerAdapter> = {}) => {
  const seen = { fed: false, ended: false }
  const fake = fakeAdapter(seed, { feed: true })
  const adapter: MessengerAdapter = {
    ...fake,
    feed: async (onBatch, signal) => {
      seen.fed = true
      const feeding = fake.feed?.(onBatch, signal)
      stop.abort()
      await feeding
      seen.ended = true
    },
    ...change,
  }
  return { seen, connect: async () => adapter }
}

const call = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  connect: Messenger["connect"],
  signal?: AbortSignal,
  history?: "store",
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect,
    chatArgument: "a chat",
    ...(history ? { history } : {}),
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        serveCommand(messenger),
        watchCommand(messenger),
        chatsCommand(messenger),
        messagesCommand(messenger),
      ],
    },
    { streams, tty: false, env, ...(signal ? { signal } : {}) },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
}

const neverConnects: Messenger["connect"] = async () => {
  throw new Error("a store-mode read connected")
}

describe("a messenger that pushes its history", () => {
  it("**serve keeps what feed pushes, and a store-mode read answers it without connecting**", async () => {
    const { env } = sandbox()
    const stop = new AbortController()
    const { seen, connect } = pushing(stop)

    expect((await call(["serve", "--json"], env, connect, stop.signal, "store")).code).toBe(0)
    expect(seen).toEqual({ fed: true, ended: true })

    const chats = await call(["chats", "list", "--json"], env, neverConnects, undefined, "store")
    expect(chats.code).toBe(0)
    expect(
      JSON.parse(chats.stdout)
        .items.map((chat: { id: string }) => chat.id)
        .sort(),
    ).toEqual(seed.chats.map((chat) => chat.id).sort())
    const messages = await call(["messages", "list", seed.busy, "--json"], env, neverConnects, undefined, "store")
    expect(messages.code).toBe(0)
    expect(JSON.parse(messages.stdout).items.map((message: { text: string }) => message.text)).toContain("chapter 10")
  })

  it("watch keeps what feed pushes too", async () => {
    const { env } = sandbox()
    const stop = new AbortController()
    const { seen, connect } = pushing(stop)

    expect((await call(["watch", "--jsonl"], env, connect, stop.signal)).code).toBe(0)
    expect(seen.ended).toBe(true)
    const chats = await call(["chats", "list", "--json"], env, neverConnects, undefined, "store")
    expect(JSON.parse(chats.stdout).items).toHaveLength(seed.chats.length)
  })

  it("a batch the store cannot take is a warning, and serve still ends normally", async () => {
    const { root, env } = sandbox()
    mkdirSync(join(root, "m.db"))
    const stop = new AbortController()
    const { connect } = pushing(stop)

    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store")
    expect(code).toBe(0)
    expect(stderr).toContain('"severity":"warn"')
    expect(stderr).not.toContain("not saved to the local store")
  })

  it("a feed that fails ends serve with its error and leaves no lock", async () => {
    const { root, env } = sandbox()
    const stop = new AbortController()
    const { connect } = pushing(stop, {
      feed: async () => {
        throw new Error("history sync broke")
      },
    })

    const { code, stderr } = await call(["serve"], env, connect, stop.signal, "store")
    expect(code).not.toBe(0)
    expect(stderr).toContain("internal_error")
    expect(stderr).not.toContain("history sync broke")
    expect(existsSync(join(root, "state", "serve", "default.lock"))).toBe(false)
  })
})
