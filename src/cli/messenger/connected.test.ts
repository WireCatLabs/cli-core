import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Chat, Message, MessageEvent } from "../../domain/models.js"
import type { HistoryBatch, MessengerAdapter } from "../../ports/messenger.js"
import type { DiagnosticEvent, Warn, WarningEvent } from "../../runs/events.js"
import type { MessageStore } from "../../store/store.js"
import { connected, type MessengerContext } from "./context.js"
import { recordDiagnostics } from "./serve-notice.js"

const order: string[] = []
let rekeysPerPass: number | undefined
const rekeyLockWaits: number[] = []
let finishWrite: () => void = () => {}

vi.mock("../../store/store.js", () => ({
  openStore: async () =>
    ({
      chats: {
        saveChats: async () => {
          order.push("chats saved")
        },
        rekeyChat: async () => {
          order.push("rekeyed")
        },
        rekeyChats: async (_key: unknown, pairs: unknown[], lockMs: number) => {
          order.push("rekeyed")
          rekeyLockWaits.push(lockMs)
          return { taken: rekeysPerPass ?? pairs.length, applied: [], refused: [] }
        },
      },
      messages: {
        saveMessages: () =>
          new Promise<void>((resolve) => {
            finishWrite = () => {
              order.push("written")
              resolve()
            }
          }),
      },
      forAccount: () => ({ chats: { chats: async () => ({ items: [{ id: "7" }] }) } }),
      close: async () => {
        order.push("store closed")
      },
    }) as unknown as MessageStore,
}))

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const arriving = {
  self: () => "500",
  close: async () => {
    order.push("connection closed")
  },
  watch: async (onEvent: (event: MessageEvent) => void) => {
    onEvent({
      event: "message",
      message: {
        id: "1",
        chatId: "7",
        chatTitle: "Book club",
        senderId: "9",
        senderName: "Olga",
        timestamp: "2026-09-27T10:01:00.000Z",
        editedAt: null,
        text: "hello",
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    })
  },
} as unknown as MessengerAdapter

const watched = async () => {
  const warnings: string[] = []
  const held = connected(
    arriving,
    { app, provider: "chat" },
    {
      settings: { profile: "default" } as never,
      env: { CHAT_STATE_DIR: join(mkdtempSync(join(tmpdir(), "connected-")), "state") },
      renderer: { warn: (line: string) => warnings.push(line) } as never,
    },
    () => {},
  )
  await held.adapter.watch?.(() => {}, new AbortController().signal)
  return { ...held, warnings }
}

afterEach(() => {
  order.length = 0
  rekeysPerPass = undefined
  rekeyLockWaits.length = 0
  vi.useRealTimers()
})

describe("closing a connection", () => {
  it("waits for a save `watch` started, then closes the store", async () => {
    const { close } = await watched()
    const closing = close()
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(["connection closed"])

    finishWrite()
    await closing

    expect(order).toEqual(["connection closed", "written", "store closed"])
  })

  it("gives up on a save that never ends, with a warning, and still closes", async () => {
    vi.useFakeTimers()
    const { close, warnings } = await watched()

    const closing = close()
    await vi.advanceTimersByTimeAsync(5_000)
    await closing

    expect(order).toEqual(["connection closed", "store closed"])
    expect(warnings).toEqual([expect.stringContaining("still being written")])
  })

  it("abandons a stored-chats hook that never ends without saying anything went unsaved", async () => {
    vi.useFakeTimers()
    const handed: (readonly string[])[] = []
    const adapter = {
      ...arriving,
      feed: async () => {},
      storedChats: (ids: readonly string[]) => {
        handed.push(ids)
        return new Promise<void>(() => {})
      },
    } as unknown as MessengerAdapter
    const { adapter: saving, close, warnings, codes, logged } = opened(adapter, "store", { listen: true })
    await saving.feed?.(() => {}, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)

    const closing = close()
    await vi.advanceTimersByTimeAsync(5_000)
    await closing

    expect(handed).toEqual([["7"]])
    expect(order).toEqual(["connection closed", "store closed"])
    expect(codes).toEqual(["stored_chats_failed"])
    expect(warnings).toEqual([expect.stringContaining("stored-chats hook did not finish and was abandoned")])
    expect(logged).toEqual([{ event: "serve.warning", code: "stored_chats_failed", operation: "close" }])
  })
})

const arrived = (id: string): MessageEvent => ({
  event: "message",
  message: {
    id,
    chatId: "7",
    chatTitle: "Book club",
    senderId: "9",
    senderName: "Olga",
    timestamp: "2026-09-27T10:01:00.000Z",
    editedAt: null,
    text: "hello",
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  },
})

/** One passive listen: `deliver` hands on an item, `fail` ends the listen with an error. */
const passiveListen = <T>(listening: Partial<{ hangs: boolean }> = {}) => {
  let onItem: ((item: T) => void) | undefined
  let fail: (error: Error) => void = () => {}
  const listens = vi.fn(
    (handed: (item: T) => void, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        onItem = handed
        fail = reject
        if (listening.hangs) return
        signal.addEventListener(
          "abort",
          () => {
            onItem = undefined
            resolve()
          },
          { once: true },
        )
      }),
  )
  return { listens, deliver: (item: T) => onItem?.(item), fail: (error: Error) => fail(error) }
}

/** A messenger that only listens for messages. */
const passiveFake = (listening: Partial<{ hangs: boolean }> = {}) => {
  const listen = passiveListen<MessageEvent>(listening)
  const adapter = {
    ...arriving,
    watch: async (handed: (event: MessageEvent) => void) => handed(arrived("1")),
    listen: listen.listens,
  } as unknown as MessengerAdapter
  return { adapter, ...listen }
}

/** A messenger that only listens for pushed history, with a `feed` that pushes one batch. */
const historyFake = (listening: Partial<{ hangs: boolean }> = {}) => {
  const listen = passiveListen<HistoryBatch>(listening)
  const adapter = {
    ...arriving,
    feed: async (onBatch: (batch: HistoryBatch) => void) => {
      onBatch(pushed)
    },
    listenHistory: listen.listens,
  } as unknown as MessengerAdapter
  return { adapter, ...listen }
}

const pushed: HistoryBatch = {
  rekeys: [{ from: "7", to: "8" }],
  chats: [{ id: "8", title: "Book club" } as Chat],
  messages: [{ ...(arrived("2") as { message: Message }).message, chatId: "8" }],
}

const opened = (
  adapter: MessengerAdapter,
  history: "store" | "server" | undefined,
  connect: { listen?: boolean; closeWaitMs?: number; rekeyPacing?: { lockMs: number; pauseMs: number } } = {},
) => {
  const warnings: string[] = []
  const codes: string[] = []
  const recorded: DiagnosticEvent[] = []
  const logged: Record<string, unknown>[] = []
  const serveLog = recordDiagnostics(
    {
      format: "json",
      settings: { quiet: false },
      renderer: {},
      streams: { diagnostic: (line: string) => logged.push(JSON.parse(line).attributes) },
    } as unknown as MessengerContext,
    app,
  )
  const logWarn = serveLog.renderer.warn as Warn
  const held = connected(
    adapter,
    { app, provider: "chat", ...(history ? { history } : {}) },
    {
      settings: { profile: "default" } as never,
      env: { CHAT_STATE_DIR: join(mkdtempSync(join(tmpdir(), "connected-")), "state") },
      renderer: {
        warn: (line: string, warning?: WarningEvent) => {
          warnings.push(line)
          logWarn(line, warning)
        },
      } as never,
    },
    (event) => {
      recorded.push(event)
      if (event.event === "warning") codes.push(event.code)
    },
    undefined,
    connect,
  )
  return { ...held, warnings, codes, recorded, logged }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe("a one-shot command of a messenger whose history is in the store", () => {
  it("saves a message the connection hands on, and closes only once it is written", async () => {
    const fake = passiveFake()
    const { close } = opened(fake.adapter, "store")
    await tick()
    fake.deliver(arrived("2"))

    const closing = close()
    await tick()
    expect(order).toEqual(["connection closed"])
    finishWrite()
    await closing

    expect(fake.listens).toHaveBeenCalledOnce()
    expect(fake.listens.mock.calls[0]?.[1].aborted).toBe(true)
    expect(order).toEqual(["connection closed", "written", "store closed"])
  })

  it("records how many of each event the listen handed on, as watch does", async () => {
    const fake = passiveFake()
    const { close, recorded } = opened(fake.adapter, "store")
    await tick()
    for (const id of ["2", "3"]) {
      fake.deliver(arrived(id))
      await tick()
      finishWrite()
    }
    await close()

    expect(recorded).toContainEqual(
      expect.objectContaining({
        event: "response",
        operation: "messages.listen",
        outcome: "ok",
        counts: { message: 2 },
      }),
    )
  })

  it("saves a message the connection hands on while it closes, before the store closes", async () => {
    const fake = passiveFake()
    const closingAdapter = {
      ...fake.adapter,
      close: async () => {
        fake.deliver(arrived("3"))
        order.push("connection closed")
      },
    } as unknown as MessengerAdapter
    const { close } = opened(closingAdapter, "store")
    await tick()

    const closing = close()
    await tick()
    expect(order).toEqual(["connection closed"])
    finishWrite()
    await closing

    expect(order).toEqual(["connection closed", "written", "store closed"])
  })

  it("leaves a connection that watches to its watch, so each message is saved once", async () => {
    const fake = passiveFake()
    const { adapter, close } = opened(fake.adapter, "store", { listen: true })
    await adapter.watch?.(() => {}, new AbortController().signal)
    await tick()

    const closing = close()
    finishWrite()
    await closing

    expect(fake.listens).not.toHaveBeenCalled()
    expect(order).toEqual(["connection closed", "written", "store closed"])
  })

  it("does not listen for a messenger that answers history from its server", async () => {
    const fake = passiveFake()
    await opened(fake.adapter, "server").close()

    expect(fake.listens).not.toHaveBeenCalled()
  })

  it("closes as before for a messenger that cannot listen", async () => {
    const { close, warnings } = opened(arriving, "store")
    await close()

    expect(order).toEqual(["connection closed"])
    expect(warnings).toEqual([])
  })

  it("warns when the listen fails, and the command goes on", async () => {
    const fake = passiveFake()
    const { close, warnings, codes, logged } = opened(fake.adapter, "store")
    await tick()
    fake.fail(new Error("the engine stopped"))
    await tick()
    await close()

    expect(warnings).toEqual([expect.stringContaining("the engine stopped")])
    expect(codes).toEqual(["listen_failed"])
    expect(logged).toEqual([{ event: "serve.warning", code: "listen_failed", operation: "messages.listen" }])
    expect(order).toEqual(["connection closed"])
  })

  it("says nothing of a listen that fails because the connection is closing", async () => {
    const fake = passiveFake()
    const closingAdapter = {
      ...fake.adapter,
      listen: fake.adapter.listen,
      close: async () => {
        fake.fail(new Error("closed"))
        order.push("connection closed")
      },
    } as unknown as MessengerAdapter
    const { close, warnings } = opened(closingAdapter, "store")
    await tick()
    await close()

    expect(warnings).toEqual([])
  })

  it("gives up on a listen that never ends, with a warning, and still closes", async () => {
    vi.useFakeTimers()
    const fake = passiveFake({ hangs: true })
    const { close, warnings, codes, logged } = opened(fake.adapter, "store")
    await vi.advanceTimersByTimeAsync(0)

    const closing = close()
    await vi.advanceTimersByTimeAsync(5_000)
    await closing

    expect(order).toEqual(["connection closed"])
    expect(warnings).toEqual([expect.stringContaining("still handing on messages")])
    expect(codes).toEqual(["store_not_written"])
    expect(logged).toEqual([{ event: "serve.warning", code: "store_not_written", operation: "messages.listen" }])
  })

  it("gives up on a listen that never ends within the close wait a test hands in", async () => {
    const fake = passiveFake({ hangs: true })
    const { close, warnings, codes } = opened(fake.adapter, "store", { closeWaitMs: 1 })
    await tick()
    const started = performance.now()

    await close()

    expect(performance.now() - started).toBeLessThan(1_000)
    expect(warnings).toEqual([expect.stringContaining("still handing on messages")])
    expect(codes).toEqual(["store_not_written"])
  })
})

describe("a one-shot command of a messenger whose history is pushed", () => {
  it("saves a pushed batch as feed does, re-keys first, and closes only once it is written", async () => {
    const fake = historyFake()
    const { close, warnings } = opened(fake.adapter, "store")
    await tick()
    fake.deliver(pushed)
    await tick()

    const closing = close()
    await tick()
    expect(order).toEqual(["rekeyed", "chats saved", "connection closed"])
    finishWrite()
    await closing

    expect(fake.listens).toHaveBeenCalledOnce()
    expect(fake.listens.mock.calls[0]?.[1].aborted).toBe(true)
    expect(order).toEqual(["rekeyed", "chats saved", "connection closed", "written", "store closed"])
    expect(warnings).toEqual([])
  })

  it("gives up the re-keys still queued at close with one plain warning, not one per chat", async () => {
    vi.useFakeTimers()
    rekeysPerPass = 1
    const fake = historyFake()
    const { close, warnings, recorded } = opened(fake.adapter, "store")
    await vi.advanceTimersByTimeAsync(0)
    fake.deliver({ rekeys: Array.from({ length: 400 }, (_, at) => ({ from: `${at}`, to: `${at}@lid` })) })

    const closing = close()
    await vi.advanceTimersByTimeAsync(5_000)
    await closing
    const passes = order.filter((step) => step === "rekeyed").length

    expect(passes).toBeGreaterThan(1)
    expect(passes).toBeLessThan(400)
    expect(warnings).toEqual([`${400 - passes} chat re-keys not applied yet; the next serve applies them`])
    expect(recorded.filter((event) => event.event === "warning")).toEqual([
      { event: "warning", code: "rekeys_not_applied", operation: "history.rekey", counts: { rekeys: 400 - passes } },
    ])
    expect(order.at(-1)).toBe("store closed")
  })

  it("paces the re-keys as the test hands in", async () => {
    rekeysPerPass = 1
    const fake = historyFake()
    const { close, warnings } = opened(fake.adapter, "store", { rekeyPacing: { lockMs: 7, pauseMs: 0 } })
    await tick()
    fake.deliver({ rekeys: [1, 2, 3].map((at) => ({ from: `${at}`, to: `${at}@lid` })) })

    await close()

    expect(rekeyLockWaits).toEqual([7, 7, 7])
    expect(warnings).toEqual([])
  })

  it("records how many batches, and of each part, the listen handed on", async () => {
    const fake = historyFake()
    const { close, recorded } = opened(fake.adapter, "store")
    await tick()
    fake.deliver(pushed)
    await tick()
    finishWrite()
    await close()

    expect(recorded).toContainEqual(
      expect.objectContaining({
        event: "response",
        operation: "history.listen",
        outcome: "ok",
        counts: { batches: 1, rekeys: 1, chats: 1, messages: 1 },
      }),
    )
  })

  it("leaves a connection that watches to its feed, so each batch is saved once", async () => {
    const fake = historyFake()
    const { adapter, close } = opened(fake.adapter, "store", { listen: true })
    await adapter.feed?.(() => {}, new AbortController().signal)
    await tick()

    const closing = close()
    finishWrite()
    await closing

    expect(fake.listens).not.toHaveBeenCalled()
    expect(order).toEqual(["rekeyed", "chats saved", "connection closed", "written", "store closed"])
  })

  it("does not listen for history of a messenger that answers it from its server", async () => {
    const fake = historyFake()
    await opened(fake.adapter, "server").close()

    expect(fake.listens).not.toHaveBeenCalled()
  })

  it("warns when the history listen fails, and the command goes on", async () => {
    const fake = historyFake()
    const { close, warnings, codes, logged } = opened(fake.adapter, "store")
    await tick()
    fake.fail(new Error("the engine stopped"))
    await tick()
    await close()

    expect(warnings).toEqual([expect.stringMatching(/^history batches .*the engine stopped/)])
    expect(codes).toEqual(["listen_failed"])
    expect(logged).toEqual([{ event: "serve.warning", code: "listen_failed", operation: "history.listen" }])
    expect(order).toEqual(["connection closed"])
  })

  it("says nothing of a history listen that fails because the connection is closing", async () => {
    const fake = historyFake()
    const closingAdapter = {
      ...fake.adapter,
      close: async () => {
        fake.fail(new Error("closed"))
        order.push("connection closed")
      },
    } as unknown as MessengerAdapter
    const { close, warnings } = opened(closingAdapter, "store")
    await tick()
    await close()

    expect(warnings).toEqual([])
  })

  it("waits at most 5 s in all for both listens that never end, warns for each, and still closes", async () => {
    vi.useFakeTimers()
    const messages = passiveFake({ hangs: true })
    const history = historyFake({ hangs: true })
    const both = { ...messages.adapter, listenHistory: history.listens } as unknown as MessengerAdapter
    const { close, warnings, codes, recorded } = opened(both, "store")
    await vi.advanceTimersByTimeAsync(0)

    const closing = close()
    await vi.advanceTimersByTimeAsync(5_000)
    await closing

    expect(order).toEqual(["connection closed"])
    expect(warnings).toEqual([
      expect.stringContaining("still handing on messages"),
      expect.stringContaining("still handing on history batches"),
    ])
    expect(codes).toEqual(["store_not_written", "store_not_written"])
    expect(recorded.filter((event) => event.event === "warning").map((event) => event.operation)).toEqual([
      "messages.listen",
      "history.listen",
    ])
  })
})
