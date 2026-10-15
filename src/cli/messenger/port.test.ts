import { describe, expect, it } from "vitest"
import { capability, type MessengerAdapter } from "../../ports/messenger.js"
import type { DiagnosticEvent } from "../../runs/events.js"
import { observed } from "./observed.js"
import { stored } from "./stored.js"

/** A class, as a real adapter is: a method must reach it with `this` intact. */
class Adapter {
  readonly #edits: string[] = []
  self() {
    return "1"
  }
  async archive(chat: string, text: string) {
    this.#edits.push(`${chat}:${text}`)
    return this.#edits.length
  }
}

describe("a method the wrappers were never told about", () => {
  it("passes through both wrappers to the adapter, timed under its own name", async () => {
    const events: DiagnosticEvent[] = []
    const inner = new Adapter() as unknown as MessengerAdapter & { archive: Adapter["archive"] }
    const wrapped = stored(
      observed(inner, (event) => events.push(event)),
      {
        account: { provider: "chat", account: "1" },
        store: async () => undefined,
        warn: () => {},
        events: () => {},
      },
    ) as typeof inner

    expect(await wrapped.archive("7", "fixed")).toBe(1)
    expect(events.map((event) => [event.event, "operation" in event ? event.operation : ""])).toEqual([
      ["request", "adapter.archive"],
      ["response", "adapter.archive"],
    ])
  })

  it("is refused by name when the messenger does not have it", () => {
    const adapter = new Adapter() as unknown as MessengerAdapter

    expect(() => capability(adapter, "watch", "listen for new messages")).toThrow(
      "this messenger cannot listen for new messages",
    )
  })
})
