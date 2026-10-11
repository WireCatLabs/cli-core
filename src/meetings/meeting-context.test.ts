import { CliError } from "@wirecat/cli-core"
import { describe, expect, it, vi } from "vitest"
import { createMeetingContext, type MeetingContextChange, validateMeetingContextChange } from "./meeting-context.js"

describe("meeting context", () => {
  it("captures scope, actions and class dispatch; preview is pure and apply occurs once", async () => {
    const scope = { provider: "example", account: "account-one" }
    class Ports {
      actions = ["note.add", "tags.add"] as const
      apply = vi.fn(async () => ({ reference: "note:1" }))
    }
    const ports = new Ports()
    const context = createMeetingContext(scope, 1, ports)
    scope.account = "changed"
    const change: MeetingContextChange = { action: "note.add", text: " Example note ", title: " Example " }
    expect(await context.change(2, change)).toMatchObject({
      applied: false,
      change: { action: "note.add", text: "Example note", title: "Example" },
      scope: { provider: "example", account: "account-one" },
      accountId: 1,
    })
    await context.change(2, change, { apply: true, dryRun: true })
    expect(ports.apply).not.toHaveBeenCalled()
    const controller = new AbortController()
    expect(await context.change(2, change, { apply: true, signal: controller.signal })).toMatchObject({
      applied: true,
      result: { reference: "note:1" },
    })
    expect(ports.apply).toHaveBeenCalledExactlyOnceWith(
      2,
      { action: "note.add", text: "Example note", title: "Example" },
      {
        scope: { provider: "example", account: "account-one" },
        accountId: 1,
        signal: controller.signal,
      },
    )
    const tags = [" example ", "example"]
    const result = await context.change(2, { action: "tags.add", tags })
    tags.push("changed")
    expect(result.change).toEqual({ action: "tags.add", tags: ["example"] })
    expect(Object.isFrozen(result.change)).toBe(true)
    await expect(context.change(2, { action: "event.link", eventId: 3 })).rejects.toMatchObject({
      code: "provider_unavailable",
    })
    controller.abort()
    await expect(context.change(2, change, { apply: true, signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
  })

  it("preserves uncertain failures without retrying", async () => {
    const error = new CliError("configuration_error", "outcome unknown")
    const apply = vi.fn(async () => {
      throw error
    })
    const context = createMeetingContext({ provider: "example", account: "one" }, 1, { actions: ["note.add"], apply })
    await expect(context.change(1, { action: "note.add", text: "Example" }, { apply: true })).rejects.toBe(error)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(() => createMeetingContext({ provider: "example", account: "one" }, 0, { actions: [], apply })).toThrow()
    expect(() =>
      createMeetingContext({ provider: "example", account: "one" }, 1, { actions: ["invalid"] as never, apply }),
    ).toThrow()
    await expect(context.change(0, { action: "note.add", text: "Example" })).rejects.toThrow()
  })

  it.each<MeetingContextChange>([
    { action: "note.add", text: "Example" },
    { action: "tags.remove", tags: ["example"] },
    { action: "memory.add", body: "Example", kind: "fact", scope: "work", evidence: ["meeting:1/2"] },
    {
      action: "memory.add",
      body: "Example",
      kind: "summary",
      scope: "personal",
      evidence: ["meeting:1/2/3/0"],
      subject: "meeting:1/2",
    },
    { action: "event.link", eventId: null },
    { action: "event.link", eventId: 3, expectedEventId: null },
    { action: "event.link", eventId: 3, expectedEventId: 2 },
    { action: "person.link", participantId: 2, personUid: "3" },
    { action: "person.link", participantId: 2, personUid: "3", expectedPersonUid: null },
    { action: "person.link", participantId: 2, personUid: "3", expectedPersonUid: "4", targetAccountIds: [1, 2, 1] },
  ])("validates supported context changes: $action", (change) => {
    expect(validateMeetingContextChange(change).action).toBe(change.action)
  })

  it.each([
    null,
    [],
    { action: "invalid" },
    { action: "__proto__" },
    { action: "note.add", text: "Example", extra: true },
    { action: "note.add", text: "" },
    { action: "note.add", text: 1 },
    { action: "note.add", text: "\0" },
    { action: "note.add", text: "x".repeat(100_001) },
    { action: "note.add", text: "Example", title: "" },
    { action: "tags.add", tags: [] },
    { action: "tags.add", tags: "example" },
    { action: "tags.add", tags: Array(101).fill("example") },
    { action: "memory.add", body: "Example", kind: "unknown", scope: "work", evidence: ["meeting:1/2"] },
    { action: "memory.add", body: "Example", kind: "fact", scope: "unknown", evidence: ["meeting:1/2"] },
    { action: "event.link", eventId: 0 },
    { action: "event.link", eventId: 1.5 },
    { action: "event.link", eventId: "1" },
    { action: "person.link", participantId: 1, personUid: "wrong" },
    { action: "person.link", participantId: 1, personUid: "9007199254740992" },
    { action: "person.link", participantId: 1, personUid: "1", targetAccountIds: [] },
    { action: "person.link", participantId: 1, personUid: "1", targetAccountIds: "1" },
    { action: "person.link", participantId: 1, personUid: "1", targetAccountIds: Array(1001).fill(1) },
    { action: "person.link", participantId: 1, personUid: "1", targetAccountIds: [0] },
  ])("rejects malformed changes %#", (change) => {
    expect(() => validateMeetingContextChange(change as MeetingContextChange)).toThrow()
  })
})
