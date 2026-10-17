import { describe, expect, it } from "vitest"
import { bareCheck, type CheckWords, checkWords } from "./checks.js"

type Check = "chats.list" | "session.start"

describe("check words", () => {
  it("names a check by its path alone without the command layer", () => {
    const words: CheckWords<Check> = bareCheck

    expect(words("chats.list")).toBe("`chats list`")
    expect(words("session.start", "phone")).toBe("`session start phone`")
  })

  it("puts the CLI and the profile first in the command layer's words", () => {
    expect(checkWords<Check>("wa", "personal")("session.start")).toBe("`wa personal session start`")
    expect(checkWords<Check>("tg")("chats.list", "--limit 5")).toBe("`tg chats list --limit 5`")
  })
})
