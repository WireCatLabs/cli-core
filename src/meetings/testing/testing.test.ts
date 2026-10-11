import { describe, expect, it } from "vitest"
import { fakeMeetingSource, meetingStoreContract, memoryMeetingStore } from "./index.js"

describe("MeetingStore contract", () => {
  for (const c of meetingStoreContract(memoryMeetingStore)) it(c.name, c.run)
})
it("fake source is usable and accepts overrides", async () => {
  const s = fakeMeetingSource()
  expect((await s.meetings("")).length).toBe(1)
  expect((await s.transcript("example-occurrence"))?.length).toBe(1)
  expect(await s.participants("example-occurrence")).toBeNull()
  expect(await s.files("example-occurrence")).toBeNull()
  expect(await s.chat("example-occurrence")).toBeNull()
  expect(await s.summary("example-occurrence")).toBeNull()
  expect(fakeMeetingSource({ provider: "other" }).provider).toBe("other")
})
