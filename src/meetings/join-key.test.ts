import { describe, expect, it } from "vitest"
import { joinKeyOf, joinUrlWithoutQuery } from "./join-key.js"

describe("a meeting's join key", () => {
  it.each([
    ["https://example.zoom.us/j/81234567890?pwd=SECRETSECRET", "zoom:81234567890"],
    ["https://zoom.us/w/81234567890?tk=x", "zoom:81234567890"],
    ["https://us02web.zoom.us/wc/join/81234567890", "zoom:81234567890"],
    ["https://meet.google.com/abc-defg-hij?authuser=1", "meet:abc-defg-hij"],
    [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting/0?context=x",
      "teams.microsoft.com/l/meetup-join/19%3ameeting/0",
    ],
  ])("of %s is %s, with no passcode", (url, key) => {
    expect(joinKeyOf(url)).toBe(key)
    expect(joinKeyOf(url)).not.toMatch(/pwd|SECRET|tk=/)
  })

  it("is nothing for no link or one that is not a web link", () => {
    expect(joinKeyOf(null)).toBeNull()
    expect(joinKeyOf("tel:+15550100")).toBeNull()
    expect(joinKeyOf("not a link")).toBeNull()
  })

  it("keeps a stored link without its query string or fragment", () => {
    expect(joinUrlWithoutQuery("https://example.zoom.us/j/81234567890?pwd=SECRET#success")).toBe(
      "https://example.zoom.us/j/81234567890",
    )
  })
})
