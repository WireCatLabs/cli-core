import { describe, expect, it } from "vitest"
import { isNoReplyAddress, isNotificationAddress, isRoleAddress } from "./addresses.js"

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

  it("of the no-reply family is found by any part, or a start or an end of the local part", () => {
    for (const address of [
      "noreply-12345@x.test",
      "service-noreply@x.test",
      "service.no-reply.eu@x.test",
      "DoNotReply_billing@x.test",
      "bounce-8812@x.test",
      "news.bounces@x.test",
      "bounce.house@x.test",
    ])
      expect([address, isNoReplyAddress(address), isRoleAddress(address)]).toEqual([address, true, true])
    for (const address of ["bouncer.joe@x.test", "anna.bounceback@x.test", "noreen.ply@x.test", "anna+noreply@x.test"])
      expect([address, isNoReplyAddress(address)]).toEqual([address, false])
  })
})

describe("a notification address", () => {
  it("has a notification word as its whole local part or one of its parts", () => {
    for (const address of ["notify@x.test", "Notifications@x.test", "bank-alerts@x.test", "alert.eu+x@x.test"])
      expect([address, isNotificationAddress(address)]).toEqual([address, true])
    for (const address of ["notifyme.anna@x.test", "alerton@x.test", "ivan@x.test"])
      expect([address, isNotificationAddress(address)]).toEqual([address, false])
  })

  it("is no no-reply address, and only the role words stay role addresses", () => {
    expect(isNoReplyAddress("notify@x.test")).toBe(false)
    expect(isRoleAddress("notify@x.test")).toBe(false)
    expect(isRoleAddress("notifications@x.test")).toBe(true)
  })
})
