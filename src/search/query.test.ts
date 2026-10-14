import { describe, expect, it } from "vitest"
import { sourceOf } from "./query.js"

describe("sourceOf", () => {
  it("**takes any messenger the store holds**, and only those", () => {
    expect(sourceOf("in:", "WhatsApp", ["whatsapp"])).toBe("whatsapp")
    expect(() => sourceOf("in:", "telegram", [])).toThrow(
      'in: takes personal, bots, all, messages, mail — not "telegram"',
    )
  })

  it("**takes a kind or a provider's alias**", () => {
    const providers = ["telegram", "email", "folder"]
    expect(sourceOf("in:", "tg", providers)).toBe("telegram")
    expect(sourceOf("in:", "messages", providers)).toBe("messages")
    expect(sourceOf("in:", "mail", providers)).toBe("email")
    expect(() => sourceOf("in:", "notes", providers)).toThrow(
      "in:notes names notes, which a message search does not read — search notes does",
    )
    expect(() => sourceOf("in:", "max", providers)).toThrow('— not "max"')
  })
})
