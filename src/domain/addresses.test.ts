import { describe, expect, it } from "vitest"
import { isNoReplyAddress, isRoleAddress } from "./addresses.js"

describe("a role address", () => {
  it("is one whose whole local part is a role word, any case, past a +tag and separators", () => {
    expect(isRoleAddress("info@x.com")).toBe(true)
    expect(isRoleAddress("Hello+news@x.com")).toBe(true)
    expect(isRoleAddress("no_reply@x.com")).toBe(true)
    expect(isRoleAddress("do-not-reply@x.com")).toBe(true)
    expect(isRoleAddress("ivan.info@x.com")).toBe(false)
    expect(isRoleAddress("ivan@x.com")).toBe(false)
  })

  it("of the no-reply family names no one", () => {
    expect(isNoReplyAddress("noreply@x.com")).toBe(true)
    expect(isNoReplyAddress("No-Reply+x@x.com")).toBe(true)
    expect(isNoReplyAddress("Mailer-Daemon@x.com")).toBe(true)
    expect(isNoReplyAddress("info@x.com")).toBe(false)
  })
})
