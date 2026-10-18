import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageEvent } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { MessageStore } from "../../store/store.js"
import { connected } from "./context.js"

const order: string[] = []
let finishWrite: () => void = () => {}

vi.mock("../../store/store.js", () => ({
  openStore: async () =>
    ({
      messages: {
        saveMessages: () =>
          new Promise<void>((resolve) => {
            finishWrite = () => {
              order.push("written")
              resolve()
            }
          }),
      },
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

/** A messenger that only listens: `deliver` hands on a message, `fail` ends the listen with an error. */
const passiveFake = (listening: Partial<{ hangs: boolean }> = {}) => {
  let onEvent: ((event: MessageEvent) => void) | undefined
  let fail: (error: Error) => void = () => {}
  const listens = vi.fn(
    (handed: (event: MessageEvent) => void, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        onEvent = handed
        fail = reject
        if (!listening.hangs) signal.addEventListener("abort", () => resolve(), { once: true })
      }),
  )
  const adapter = {
    ...arriving,
    watch: async (handed: (event: MessageEvent) => void) => handed(arrived("1")),
    listen: listens,
  } as unknown as MessengerAdapter
  return { adapter, listens, deliver: (event: MessageEvent) => onEvent?.(event), fail: (error: Error) => fail(error) }
}

const opened = (
  adapter: MessengerAdapter,
  history: "store" | "server" | undefined,
  connect: { listen?: boolean } = {},
) => {
  const warnings: string[] = []
  const codes: string[] = []
  const held = connected(
    adapter,
    { app, provider: "chat", ...(history ? { history } : {}) },
    {
      settings: { profile: "default" } as never,
      env: { CHAT_STATE_DIR: join(mkdtempSync(join(tmpdir(), "connected-")), "state") },
      renderer: { warn: (line: string) => warnings.push(line) } as never,
    },
    (event) => {
      if (event.event === "warning") codes.push(event.code)
    },
    undefined,
    connect,
  )
  return { ...held, warnings, codes }
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
    const { close, warnings, codes } = opened(fake.adapter, "store")
    await tick()
    fake.fail(new Error("the engine stopped"))
    await tick()
    await close()

    expect(warnings).toEqual([expect.stringContaining("the engine stopped")])
    expect(codes).toEqual(["listen_failed"])
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
    const { close, warnings, codes } = opened(fake.adapter, "store")
    await vi.advanceTimersByTimeAsync(0)

    const closing = close()
    await vi.advanceTimersByTimeAsync(5_000)
    await closing

    expect(order).toEqual(["connection closed"])
    expect(warnings).toEqual([expect.stringContaining("still handing on messages")])
    expect(codes).toEqual(["store_not_written"])
  })
})
