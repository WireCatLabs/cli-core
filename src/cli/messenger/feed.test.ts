import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Message } from "../../domain/models.js"
import { contractSeed, fakeAdapter } from "../../kit/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { RecipientList } from "../../sends/recipients.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { serveCommand } from "./serve-command.js"
import { watchCommand } from "./watch-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const seed = contractSeed()

afterEach(() => {
  vi.restoreAllMocks()
})

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
  waits: { closeWaitMs?: number; rekeyPacing?: { lockMs: number; pauseMs: number } } = {},
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
    { streams, tty: false, env, ...waits, ...(signal ? { signal } : {}) },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
}

const warningAttributes = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.includes('"body":"serve.warning"'))
    .map((line) => JSON.parse(line).attributes)

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

  it("**a re-key in a batch joins the chat stored under the old id with the batch's messages under the new one**", async () => {
    const { env } = sandbox()
    const stop = new AbortController()
    const said = (id: string, chatId: string, text: string) => ({
      id,
      chatId,
      senderId: "7",
      senderName: "Ana",
      timestamp: "2026-10-18T10:00:00.000Z",
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    const { connect } = pushing(stop, {
      feed: async (onBatch) => {
        onBatch({ messages: [said("1", "5550001", "under the phone")] })
        onBatch({ rekeys: [{ from: "5550001", to: "9990001" }], messages: [said("2", "9990001", "under the lid")] })
        stop.abort()
      },
    })

    expect((await call(["serve", "--json"], env, connect, stop.signal, "store")).code).toBe(0)
    const chats = await call(["chats", "list", "--json"], env, neverConnects, undefined, "store")
    expect(JSON.parse(chats.stdout).items.map((chat: { id: string }) => chat.id)).toEqual(["9990001"])
    const messages = await call(["messages", "list", "9990001", "--json"], env, neverConnects, undefined, "store")
    expect(
      JSON.parse(messages.stdout)
        .items.map((message: { text: string }) => message.text)
        .sort(),
    ).toEqual(["under the lid", "under the phone"])
  })

  it("a re-key moves the chat in the profile's recipient list once the store took it", async () => {
    const { root, env } = sandbox()
    const list = join(root, "state", "profiles", "default.recipients.json")
    mkdirSync(join(root, "state", "profiles"), { recursive: true })
    writeFileSync(list, JSON.stringify({ chats: [{ id: "5550001", title: "Ana", addedAt: "2026-10-01T00:00:00Z" }] }))
    const stop = new AbortController()
    const { connect } = pushing(stop, {
      feed: async (onBatch) => {
        onBatch({ rekeys: [{ from: "5550001", to: "9990001" }] })
        stop.abort()
      },
    })

    expect((await call(["serve", "--json"], env, connect, stop.signal, "store")).code).toBe(0)
    expect(JSON.parse(readFileSync(list, "utf8")).chats.map((chat: { id: string }) => chat.id)).toEqual(["9990001"])
  })

  it("**serve tells the messenger a recipient no chat is stored under, and its re-key moves the entry**", async () => {
    const { root, env } = sandbox()
    const list = join(root, "state", "profiles", "default.recipients.json")
    mkdirSync(join(root, "state", "profiles"), { recursive: true })
    writeFileSync(list, JSON.stringify({ chats: [{ id: "5550002", title: "Ben", addedAt: "2026-10-01T00:00:00Z" }] }))
    const stop = new AbortController()
    let told: readonly string[] = []
    let typed: readonly string[] | undefined
    let heard = () => {}
    const toldOnce = new Promise<void>((resolve) => {
      heard = resolve
    })
    const { connect } = pushing(stop, {
      storedChats: async (ids, recipients) => {
        told = ids
        typed = recipients
        heard()
      },
      feed: async (onBatch) => {
        await toldOnce
        onBatch({ rekeys: [{ from: "5550002", to: "9990002" }] })
        stop.abort()
      },
    })

    expect((await call(["serve", "--json"], env, connect, stop.signal, "store")).code).toBe(0)
    expect(told).not.toContain("5550002")
    expect(typed).toEqual(["5550002"])
    expect(JSON.parse(readFileSync(list, "utf8")).chats.map((chat: { id: string }) => chat.id)).toEqual(["9990002"])
  })

  it("a refused re-key leaves the chat split and still keeps the batch's messages", async () => {
    const { env } = sandbox()
    const stop = new AbortController()
    const { connect } = pushing(stop, {
      feed: async (onBatch) => {
        onBatch({ chats: seed.chats })
        onBatch({
          rekeys: [{ from: seed.dialog, to: seed.busy }],
          messages: [{ ...(seed.messages[0] as Message), id: "kept-1", chatId: seed.busy, text: "still saved" }],
        })
        stop.abort()
      },
    })
    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store")
    expect(code).toBe(0)
    expect(warningAttributes(stderr)).toEqual([
      { event: "serve.warning", code: "store_not_written", operation: "history.rekey" },
    ])
    const messages = await call(["messages", "list", seed.busy, "--json"], env, neverConnects, undefined, "store")
    expect(JSON.parse(messages.stdout).items.map((message: { text: string }) => message.text)).toContain("still saved")
  })

  it("a batch the store cannot take is a warning, and serve still ends normally", async () => {
    const { root, env } = sandbox()
    mkdirSync(join(root, "m.db"))
    const stop = new AbortController()
    const { connect } = pushing(stop)

    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store")
    expect(code).toBe(0)
    expect(warningAttributes(stderr)).toContainEqual(expect.objectContaining({ code: "store_not_written" }))
    expect(stderr).not.toContain("not saved to the local store")
  })

  it("re-keys given up at exit log their code and how many, never the sentence", async () => {
    const { env } = sandbox()
    const stop = new AbortController()
    const { connect } = pushing(stop, {
      feed: async (onBatch) => {
        onBatch({ chats: seed.chats })
        onBatch({ rekeys: seed.chats.slice(0, 3).map((chat) => ({ from: chat.id, to: `${chat.id}@lid` })) })
        stop.abort()
      },
    })

    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store", {
      closeWaitMs: 10,
      rekeyPacing: { lockMs: 0, pauseMs: 60_000 },
    })

    expect(code).toBe(0)
    const [warning, ...more] = warningAttributes(stderr)
    expect(more).toEqual([])
    expect(warning).toMatchObject({ event: "serve.warning", code: "rekeys_not_applied", operation: "history.rekey" })
    // A slow machine closes before the first pass, so it gives up all three.
    expect([2, 3]).toContain(warning.counts.rekeys)
    expect(stderr).not.toContain("not applied yet")
  })

  it("a stored-chats hook that fails logs its code, never the error it quotes", async () => {
    const { env } = sandbox()
    const stop = new AbortController()
    const { connect } = pushing(stop, {
      storedChats: async () => {
        throw new Error("MARKER-Fake Book Club +10000000000")
      },
    })

    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store")

    expect(code).toBe(0)
    expect(warningAttributes(stderr)).toEqual([
      { event: "serve.warning", code: "stored_chats_failed", operation: "history.stored_chats" },
    ])
    expect(stderr).not.toContain("MARKER")
  })

  it("a recipient-list re-key that fails logs its code, never the chat id or the error", async () => {
    const { root, env } = sandbox()
    mkdirSync(join(root, "state", "profiles"), { recursive: true })
    writeFileSync(
      join(root, "state", "profiles", "default.recipients.json"),
      JSON.stringify({ chats: [{ id: "+10000000001", title: "Fake Ana", addedAt: "2026-10-01T00:00:00Z" }] }),
    )
    vi.spyOn(RecipientList.prototype, "rekey").mockRejectedValue(new Error("MARKER-Fake Book Club"))
    const stop = new AbortController()
    const { connect } = pushing(stop, {
      feed: async (onBatch) => {
        onBatch({ rekeys: [{ from: "+10000000001", to: "9990001" }] })
        stop.abort()
      },
    })

    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store")

    expect(code).toBe(0)
    expect(warningAttributes(stderr)).toEqual([
      { event: "serve.warning", code: "recipients_not_rekeyed", operation: "recipients.rekey" },
    ])
    expect(stderr).not.toContain("MARKER")
    expect(stderr).not.toContain("10000000001")
  })

  it("a recipient list that cannot be read logs its code, never the error", async () => {
    const { env } = sandbox()
    vi.spyOn(RecipientList.prototype, "read").mockImplementation(() => {
      throw new Error("MARKER-Fake Book Club +10000000000")
    })
    const stop = new AbortController()
    const { connect } = pushing(stop, { storedChats: async () => {} })

    const { code, stderr } = await call(["serve", "--json"], env, connect, stop.signal, "store")

    expect(code).toBe(0)
    expect(warningAttributes(stderr)).toContainEqual({
      event: "serve.warning",
      code: "recipients_not_read",
      operation: "history.stored_chats",
    })
    expect(stderr).not.toContain("MARKER")
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
