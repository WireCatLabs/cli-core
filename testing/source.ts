import type { MeetingSource } from "../source.js"

export const fakeMeetingSource = (overrides: Partial<MeetingSource> = {}): MeetingSource => ({
  provider: "example",
  name: "api",
  async participants() {
    return null
  },
  async files() {
    return null
  },
  async meetings() {
    return [
      {
        series: { id: "example-series", provider: "example", title: "Example planning" },
        occurrence: {
          id: "example-occurrence",
          seriesId: "example-series",
          title: "Example planning",
          startedAt: "1970-01-01T00:00:01.000Z",
          endedAt: "1970-01-01T00:00:02.000Z",
        },
      },
    ]
  },
  async transcript() {
    return [{ startMs: 0, endMs: 1000, speaker: "Alice Example", text: "Ship the example plan." }]
  },
  async chat() {
    return null
  },
  async summary() {
    return null
  },
  ...overrides,
})
