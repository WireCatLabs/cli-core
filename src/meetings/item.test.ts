import * as v from "valibot"
import { expect, it } from "vitest"
import { meeting, meetingItem } from "./item.js"
import type { Meeting } from "./model.js"

const row = (metadata: Meeting["metadata"]): Meeting => ({
  id: 7,
  accountId: 1,
  meetingSeriesId: null,
  eventId: null,
  externalId: "m-7",
  title: "Weekly review",
  description: null,
  location: null,
  joinUrl: null,
  startedAt: Date.parse("2026-10-21T14:03:00Z"),
  endedAt: null,
  durationMs: null,
  timezone: null,
  hostIdentityId: null,
  participantsCount: null,
  metadata,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
})
const owner = { provider: "zoom", account: "work" }

it("names a doubtful meeting's known issues and leaves the field out when there are none", () => {
  const doubtful = meetingItem(row({ issues: ["time_without_zone", "not_an_issue"] }), owner)
  expect(doubtful.issues).toEqual(["time_without_zone"])
  expect(v.is(meeting, doubtful)).toBe(true)
  expect(meetingItem(row(null), owner)).not.toHaveProperty("issues")
  expect(meetingItem(row({ issues: "time_without_zone" }), owner)).not.toHaveProperty("issues")
})
