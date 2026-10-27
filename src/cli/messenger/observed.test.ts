import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message, MessageEvent } from "../../domain/models.js"
import type { HistoryBatch, MessengerAdapter } from "../../ports/messenger.js"
import type { DiagnosticEvent } from "../../runs/events.js"
import { startRun } from "../../runs/run.js"
import { searchRuns } from "../runs/search.js"
import { observed } from "./observed.js"

const message: Message = {
  id: "50123456",
  chatId: "7",
  senderId: "9",
  senderName: "Private synthetic name",
  timestamp: "2026-01-01T00:00:00.000Z",
  editedAt: null,
  text: "private synthetic body",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

describe("observed message IDs in recorded runs", () => {
  for (const operation of ["messages.around", "messages.send"] as const) {
    it(`finds ${operation} by message ID after real log redaction, without its content`, async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "observed-id-"))
      const run = startRun({ runsDir, profile: "synthetic", command: operation, service: "chat", cliVersion: "1.0.0" })
      const adapter = {
        self: () => "9",
        close: async () => {},
        around: async () => [message],
        send: async () => ({ message, sendId: "90" }),
      } as unknown as MessengerAdapter
      const wrapped = observed(adapter, (event) => run.logger.info(event))
      if (operation === "messages.around") await wrapped.around?.("7", message.id, { before: 0, after: 0 })
      else await wrapped.send("7", message.text, { sendId: "90" })
      await run.finish("success")
      const result = searchRuns(runsDir, { query: message.id, profile: "synthetic", operation })
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.events.some((event) => Object.values(event.ids ?? {}).includes(message.id))).toBe(true)
      const output = readFileSync(join(run.dir, "events.jsonl"), "utf8")
      expect(output).toContain(message.id)
      expect(output).not.toContain(message.text)
      expect(output).not.toContain(message.senderName)
      expect(searchRuns(runsDir, { query: message.id, profile: "other" }).items).toHaveLength(0)
    })
  }
})

describe("observed send", () => {
  it("names the typed chat on the request and the answered chat on the response", async () => {
    const events: DiagnosticEvent[] = []
    const adapter = {
      self: () => "9",
      close: async () => {},
      send: async () => ({ message, sendId: "90" }),
    } as unknown as MessengerAdapter

    await observed(adapter, (event) => events.push(event)).send("phone-form", "hi", { sendId: "90" })

    expect(events.map((event) => [event.event, "ids" in event ? event.ids?.chat : undefined])).toEqual([
      ["request", "phone-form"],
      ["response", "7"],
    ])
  })
})

describe("observed watch", () => {
  it("counts each event it hands on, by event, on the messages.watch response", async () => {
    const arrived = { event: "message", message } as MessageEvent
    const adapter = {
      self: () => "9",
      close: async () => {},
      watch: async (onEvent: (event: MessageEvent) => void) => {
        onEvent(arrived)
        onEvent(arrived)
      },
    } as unknown as MessengerAdapter
    const recorded: DiagnosticEvent[] = []
    const handed: MessageEvent[] = []
    const wrapped = observed(adapter, (event) => recorded.push(event))

    await wrapped.watch?.((event) => handed.push(event), new AbortController().signal)

    expect(handed).toHaveLength(2)
    expect(recorded).toEqual([
      { event: "request", operation: "messages.watch", level: "operation" },
      expect.objectContaining({
        event: "response",
        operation: "messages.watch",
        outcome: "ok",
        counts: { message: 2 },
      }),
    ])
    expect("listen" in wrapped).toBe(false)
  })
})

describe("observed listenHistory", () => {
  it("counts the batches it hands on, and each part's items, on the history.listen response", async () => {
    const adapter = {
      self: () => "9",
      close: async () => {},
      listenHistory: async (onBatch: (batch: HistoryBatch) => void) => {
        onBatch({ rekeys: [{ from: "1", to: "2" }], messages: [message, message], people: [] })
        onBatch({ messages: [message] })
      },
    } as unknown as MessengerAdapter
    const recorded: DiagnosticEvent[] = []
    const wrapped = observed(adapter, (event) => recorded.push(event))

    await wrapped.listenHistory?.(() => {}, new AbortController().signal)

    expect(recorded).toContainEqual(
      expect.objectContaining({
        event: "response",
        operation: "history.listen",
        outcome: "ok",
        counts: { batches: 2, rekeys: 1, messages: 3 },
      }),
    )
  })
})

describe("observed feed", () => {
  it("records its request and response as history.feed, the name its save warnings use", async () => {
    const adapter = {
      self: () => "9",
      close: async () => {},
      feed: async (onBatch: (batch: HistoryBatch) => void) => onBatch({ messages: [message] }),
    } as unknown as MessengerAdapter
    const recorded: DiagnosticEvent[] = []
    const batches: HistoryBatch[] = []

    await observed(adapter, (event) => recorded.push(event)).feed?.(
      (batch) => batches.push(batch),
      new AbortController().signal,
    )

    expect(batches).toHaveLength(1)
    expect(recorded.map(({ event, operation }) => `${event} ${operation}`)).toEqual([
      "request history.feed",
      "response history.feed",
    ])
  })
})
