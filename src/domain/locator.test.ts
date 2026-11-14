import { describe, expect, it } from "vitest"
import { formatLocator, isLocator, parseLocator } from "./locator.js"

describe("a message locator", () => {
  it("round-trips a Telegram channel message with its negative chat id", () => {
    const locator = { provider: "telegram", account: "12345", chat: "-1001234567890", message: "42" }
    const text = formatLocator(locator)

    expect(text).toBe("msg:telegram/12345/-1001234567890/42")
    expect(isLocator(text)).toBe(true)
    expect(parseLocator(text)).toEqual(locator)
  })

  it("keeps a slash inside a part from becoming a fifth part", () => {
    const locator = { provider: "max", account: "a/b", chat: "7", message: "9" }
    expect(parseLocator(formatLocator(locator))).toEqual(locator)
  })

  it("refuses anything short of four parts, with a typed error", () => {
    expect(() => parseLocator("msg:telegram/1/2")).toThrow(expect.objectContaining({ code: "validation_error" }))
    expect(() => parseLocator("42")).toThrow(/not a message locator/)
    expect(() => parseLocator("msg:telegram/1/2/%E0")).toThrow(expect.objectContaining({ code: "validation_error" }))
  })
})
