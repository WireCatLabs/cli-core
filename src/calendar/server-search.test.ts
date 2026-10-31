import { describe, expect, it } from "vitest"
import type { EventStore } from "../meetings/index.js"
import type { EventsFound, FoundEvent } from "../services/events-search.js"
import { bothSearchAnswer } from "./server-search.js"

const stored = (ref: string, title: string): FoundEvent => ({
  ref,
  provider: "example-calendar",
  account: "owner-1",
  title,
  starts_at: "2026-11-02T09:00:00.000Z",
  ends_at: "2026-11-02T10:00:00.000Z",
  all_day: false,
  status: "confirmed",
  location: null,
  excerpt: "",
  occurrences: 1,
  updated_at: "2026-10-31T00:00:00.000Z",
  found_by: ["words"],
})

const served = (externalId: string, title: string) => ({
  provider: "example-calendar",
  account: "owner-1",
  calendar: "primary",
  external_id: externalId,
  title,
  starts_at: "2026-11-02T09:00:00.000Z",
  ends_at: "2026-11-02T10:00:00.000Z",
  all_day: false,
  status: "confirmed" as const,
  location: null,
  found_by: ["server" as const],
})

// Event 6 is an occurrence of series 3; event 7 stands alone. The provider's "weekly" is the series itself and
// "weekly_moved" one of its occurrences, stored under event 8.
const store = {
  calendars: async () => [{ id: 1, externalId: "primary" }],
  event: async (id: number) => ({ event: { id, eventSeriesId: id === 6 ? 3 : null } }),
  entry: async (_calendar: number, externalId: string) =>
    ({
      weekly: { eventId: null, eventSeriesId: 3 },
      weekly_moved: { eventId: 8, eventSeriesId: 3 },
      single: { eventId: 7, eventSeriesId: null },
    })[externalId] ?? null,
} as unknown as EventStore

describe("search --backend both", () => {
  it("marks a stored series once for the provider's series and its occurrences, and lists what the store lacks", async () => {
    const archived: EventsFound = {
      query: "planning",
      by: "words",
      hits: [stored("event:6", "Weekly planning"), stored("event:7", "One planning")],
      has_more: false,
    }
    const found = await bothSearchAnswer(
      store,
      1,
      archived,
      {
        query: "planning",
        by: "server",
        hits: [served("weekly", "Weekly planning"), served("weekly_moved", "Weekly planning"), served("new", "New")],
        has_more: false,
      },
      20,
    )

    expect(found.hits.map((hit) => ["ref" in hit ? hit.ref : hit.external_id, hit.found_by])).toEqual([
      ["event:6", ["words", "server"]],
      ["event:7", ["words"]],
      ["new", ["server"]],
    ])
    expect(found.has_more).toBe(false)
  })
})
