import { expect, it } from "vitest"
import { aggregateCallStats } from "./call-stats.js"
import { type Call, callOf, type StoredCall } from "./calls.js"

const stored = (metadata: unknown, participants: StoredCall["participants"] = []): StoredCall => ({
  meetingId: 1,
  startedAt: Date.UTC(2026, 10, 2, 9),
  durationMs: null,
  metadata,
  participants,
})

const call = (overrides: Partial<Call>): Call => ({
  meetingId: 1,
  startedAt: Date.UTC(2026, 10, 2, 9),
  direction: "incoming",
  outcome: "answered",
  waitMs: null,
  talkMs: null,
  durationMs: null,
  client: { key: "phone:+34600000001", name: null, identityId: 1 },
  placedBy: null,
  roles: true,
  answeredBy: [],
  rang: [],
  employees: [],
  ...overrides,
})

it("reads a call from metadata of the wrong shape, keeping what it cannot read unknown", () => {
  expect(
    callOf(stored({ direction: "sideways", outcome: "answered", waitMs: "12", talkMs: -5, answeredBy: "101" })),
  ).toMatchObject({ direction: null, outcome: "answered", waitMs: null, talkMs: null, answeredBy: [], employees: [] })
})

it("is not a call without a direction, an outcome or a client", () => {
  expect(callOf(stored(null))).toBeNull()
  expect(callOf(stored({ direction: "incoming" }))).not.toBeNull()
  expect(
    callOf(
      stored(null, [
        { identityId: 3, identityKey: "phone:+34600000001", role: "client", name: null, externalId: null },
      ]),
    ),
  ).not.toBeNull()
})

it("names a PBX's employees by extension and a provider without extensions by identity", () => {
  const ana = {
    identityId: 7,
    identityKey: "extension:office/101",
    role: "manager",
    name: "Ana Test",
    externalId: "101",
  }
  const pbx = callOf(stored({ direction: "incoming", outcome: "answered", answeredBy: ["101"], rang: ["102"] }, [ana]))
  expect(pbx?.employees).toEqual([
    { key: "extension:101", name: "Ana Test", identityId: 7, extension: "101" },
    { key: "extension:102", name: null, identityId: null, extension: "102" },
  ])
  const olga = { identityId: 9, identityKey: "abonent:olga", role: "manager", name: "Olga Test", externalId: null }
  const beeline = callOf(stored({ direction: "OUTBOUND", durationMs: 1000 }, [olga]))
  expect(beeline).toMatchObject({ direction: "outgoing", outcome: null, durationMs: 1000, talkMs: null })
  expect(beeline?.employees).toEqual([{ key: "identity:9", name: "Olga Test", identityId: 9, extension: null }])
})

it("leaves a missed call's callback unknown without a client, and counts one only within the window", () => {
  const missed = call({ meetingId: 1, outcome: "no_answer" })
  const anonymous = call({ meetingId: 2, outcome: "voicemail", client: null })
  const late = call({ meetingId: 3, direction: "outgoing", startedAt: Date.UTC(2026, 10, 2, 12) })
  const stats = aggregateCallStats([missed, anonymous], { callbackWithinMs: 2 * 3_600_000, later: [late] })
  expect(stats.missed).toMatchObject({ calls: 2, calledBack: 0, notCalledBack: 1, unknownCallback: 1 })
  const wider = aggregateCallStats([missed], { callbackWithinMs: 4 * 3_600_000, later: [late] })
  expect(wider.missed?.items[0]?.callback).toEqual({
    meetingId: 3,
    startedAt: Date.UTC(2026, 10, 2, 12),
    afterMs: 3 * 3_600_000,
    direction: "outgoing",
  })
})

it("does not take a later missed call from the same client as a callback", () => {
  const first = call({ meetingId: 1, outcome: "busy" })
  const again = call({ meetingId: 2, outcome: "no_answer", startedAt: Date.UTC(2026, 10, 2, 10) })
  expect(aggregateCallStats([first, again]).missed).toMatchObject({ calledBack: 0, notCalledBack: 2 })
})

it("reads hours and days in the zone, across midnight", () => {
  const stats = aggregateCallStats([call({ startedAt: Date.UTC(2026, 10, 2, 23, 30) })], { timeZone: "Europe/Madrid" })
  expect(stats.hours[0]?.calls).toBe(1)
  expect(stats.days.map(({ date }) => date)).toEqual(["2026-11-03"])
})

it("refuses an unknown zone and a callback window that is not positive", () => {
  expect(() => aggregateCallStats([], { timeZone: "Mars/Olympus" })).toThrow(/IANA/)
  expect(() => aggregateCallStats([], { callbackWithinMs: 0 })).toThrow(/--within/)
})

it("gives null for a value known to be empty, and leaves out what no call records", () => {
  const outgoing = call({ direction: "outgoing", waitMs: 4000, talkMs: 60_000 })
  const stats = aggregateCallStats([outgoing])
  expect(stats).toMatchObject({ meanWaitMs: null, maxWaitMs: null, talkMs: 60_000, shortCalls: 0 })
  expect(stats).not.toHaveProperty("durationMs")
})
