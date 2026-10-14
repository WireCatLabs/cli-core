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
      saveMessages: () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            order.push("written")
            resolve()
          }
        }),
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
