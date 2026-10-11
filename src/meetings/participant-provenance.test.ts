import { expect, it, vi } from "vitest"
import { pull } from "./pull.js"
import { fakeMeetingSource, memoryMeetingStore } from "./testing/index.js"

it("marks concrete provider keys for person association and keeps occurrence guests detached", async () => {
  const base = {
    identityExternalId: null,
    email: null,
    externalId: null,
    displayName: "Alice Example",
    role: null,
    joinedAt: null,
    leftAt: null,
    durationMs: null,
    sessions: null,
    metadata: null,
  }
  const store = memoryMeetingStore()
  const save = vi.spyOn(store, "saveMeeting")
  const source = fakeMeetingSource({
    participants: async () => [
      { ...base, identityExternalId: "example-provider-id" },
      { ...base, email: "alice@example.invalid" },
      { ...base, externalId: "example-registrant" },
      base,
      { ...base, identityExternalId: "", email: "", externalId: "" },
      { ...base, identityExternalId: " ", email: " ", externalId: " " },
    ],
  })
  await pull(source, store, { accountId: 1, now: 4000 })
  const participants = save.mock.calls[0]?.[0].participants
  expect(participants?.map(({ identity }) => identity.associatePerson)).toEqual([true, true, true, false, false, false])
  expect(participants?.[3]?.identity.externalId).toContain("@1/")
  expect(participants?.[0]?.identity.externalId).toBe("example-provider-id")
  expect(participants?.[1]?.identity.externalId).toBe("email:alice@example.invalid")
  expect(participants?.[2]?.identity.externalId).toBe("example-registrant")
})
