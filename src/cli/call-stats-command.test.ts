import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, expect, it } from "vitest"
import { callStats, type MeetingSave } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { readCallStats } from "../services/call-stats.js"
import { type MessageStore, openStore } from "../store/store.js"
import { addCallStatsCommand } from "./call-stats-command.js"
import { run } from "./program.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

// Monday 2 November 2026; Madrid is UTC+1 then.
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute)

interface Person {
  key: string
  role: "client" | "manager"
  name?: string
  number?: string
}

const callSave = (
  provider: string,
  accountId: number,
  id: string,
  startedAt: number,
  metadata: Record<string, unknown> | null,
  people: Person[],
): MeetingSave => {
  const input = sampleMeeting()
  delete input.meeting.series
  return {
    ...input,
    meeting: {
      ...input.meeting,
      accountId,
      externalId: id,
      title: id,
      startedAt,
      endedAt: null,
      durationMs: null,
      metadata,
    },
    participants: people.map((one) => ({
      ...input.participants[0],
      identity: { provider, externalId: one.key, name: one.name ?? null, metadata: null },
      displayName: one.name ?? null,
      email: null,
      role: one.role,
      joinedAt: null,
      leftAt: null,
      durationMs: null,
      externalId: one.number ?? null,
    })),
    transcripts: [],
    chat: [],
  } as MeetingSave
}

const ANA = { key: "extension:office/101", role: "manager", name: "Ana Test", number: "101" } as const
const BEN = { key: "extension:office/102", role: "manager", name: "Ben Test", number: "102" } as const
const client = (n: number): Person => ({ key: `phone:+3460000000${n}`, role: "client" })

const seed = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "pbx-test-calls-")), "store.db") })
  stores.push(store)
  const pbx = await store.accounts.saveAccount({ provider: "asterisk", account: "office" }, { name: "Office" })
  const beeline = await store.accounts.saveAccount({ provider: "beeline", account: "sales" }, { name: "Sales" })
  const call = (id: string, startedAt: number, metadata: Record<string, unknown>, people: Person[]): Promise<unknown> =>
    store.meetings.saveMeeting(callSave("asterisk", pbx, id, startedAt, metadata, people))
  const answered = { outcome: "answered" }
  await call(
    "c1",
    at(2, 9, 15),
    { ...answered, direction: "incoming", answeredBy: ["101"], rang: ["102"], waitMs: 12_000, talkMs: 180_000 },
    [client(1), ANA],
  )
  await call("c2", at(2, 10), { direction: "incoming", outcome: "no_answer", rang: ["101", "102"] }, [client(2)])
  await call(
    "c3",
    at(2, 10, 30),
    { ...answered, direction: "outgoing", placedBy: "102", waitMs: 5000, talkMs: 20_000 },
    [BEN, client(2)],
  )
  await call("c4", at(2, 18), { direction: "incoming", outcome: "voicemail" }, [client(3)])
  await call("c5", at(2, 23, 30), { direction: "incoming", outcome: "busy", rang: ["101"] }, [client(1)])
  await call(
    "c6",
    at(3, 8),
    { ...answered, direction: "incoming", answeredBy: ["101"], waitMs: 3000, talkMs: 90_000 },
    [client(1), ANA],
  )
  await call(
    "c7",
    at(2, 12),
    { ...answered, direction: "internal", placedBy: "101", answeredBy: ["102"], talkMs: 60_000 },
    [ANA, BEN],
  )
  await store.meetings.saveMeeting(callSave("asterisk", pbx, "not-a-call", at(2, 14), null, []))
  const olga = { key: "abonent:olga@example.test", role: "manager", name: "Olga Test", number: "201" } as const
  for (const [id, direction, startedAt] of [
    ["b1", "INBOUND", at(2, 11)],
    ["b2", "OUTBOUND", at(2, 15)],
  ] as const)
    await store.meetings.saveMeeting(
      callSave("beeline", beeline, id, startedAt, { direction, durationMs: 120_000, fileSize: 1 }, [olga, client(4)]),
    )
  return { store, pbx, beeline }
}

const definitionFor = (store: MessageStore, accountId: number) => ({
  app: { command: "pbx", appName: "pbx-cli", envPrefix: "PBX", description: "synthetic", version: "1.0.0" },
  commands: () => {
    const holder = new Command("pbx")
    addCallStatsCommand(holder, {
      read: async () => (request) => readCallStats(store, { ...request, accountId }),
      examples: ["pbx office stats calls show --since-time 30d --json"],
    })
    return [...holder.commands]
  },
})

const show = async (store: MessageStore, accountId: number, ...args: string[]) => {
  const definition = definitionFor(store, accountId)
  const streams = captureStreams()
  const code = await run(["stats", "calls", "show", ...args, "--json", "--no-record"], definition, {
    streams,
    tty: false,
    env: {},
  })
  expect(streams.stderr.join("")).toBe("")
  expect(code).toBe(0)
  const answer = JSON.parse(streams.stdout.join(""))
  v.parse(callStats, answer.item)
  return answer
}

it("reports a PBX's calls in the zone, with callbacks found after the selection ends", async () => {
  const { store, pbx } = await seed()
  const answer = await show(
    store,
    pbx,
    "--since-time",
    "2026-11-02",
    "--until-time",
    "2026-11-02",
    "--timezone",
    "Europe/Madrid",
  )
  const { item, meta } = answer
  expect(meta).toMatchObject({ timezone: "Europe/Madrid", window: { since: "2026-11-01T23:00:00.000Z" } })
  expect(item).toMatchObject({
    time_zone: "Europe/Madrid",
    callback_within_ms: 86_400_000,
    short_call_under_ms: 30_000,
    calls: 6,
    not_calls: 1,
    known: { direction: 6, outcome: 6, wait_ms: 2, talk_ms: 3, duration_ms: 0, roles: 5 },
    by_direction: { incoming: 4, outgoing: 1, internal: 1, unknown: 0 },
    by_outcome: { answered: 3, voicemail: 1, busy: 1, no_answer: 1, failed: 0, unknown: 0 },
    talk_ms: 260_000,
    mean_talk_ms: 86_667,
    mean_wait_ms: 12_000,
    max_wait_ms: 12_000,
    short_calls: 1,
  })
  expect(item).not.toHaveProperty("duration_ms")
  expect(item.employees).toMatchObject([
    {
      key: "extension:101",
      name: "Ana Test",
      extension: "101",
      calls: 4,
      placed: 1,
      answered: 1,
      rang_not_answered: 2,
      talk_ms: 240_000,
      mean_talk_ms: 120_000,
      mean_wait_ms: 12_000,
      max_wait_ms: 12_000,
    },
    {
      key: "extension:102",
      name: "Ben Test",
      calls: 4,
      placed: 1,
      answered: 1,
      rang_not_answered: 2,
      talk_ms: 80_000,
      mean_talk_ms: 40_000,
      mean_wait_ms: null,
    },
  ])
  expect(item.hours).toHaveLength(24)
  expect(item.hours[10]).toEqual({
    hour: 10,
    calls: 2,
    incoming: 1,
    outgoing: 1,
    internal: 0,
    answered: 1,
    missed: 1,
    talk_ms: 20_000,
  })
  expect(item.days).toEqual([
    { date: "2026-11-02", calls: 6, incoming: 4, outgoing: 1, internal: 1, answered: 3, missed: 3, talk_ms: 260_000 },
  ])
  expect(item.missed).toMatchObject({
    calls: 3,
    called_back: 2,
    not_called_back: 1,
    unknown_callback: 0,
    unknown_outcome: 0,
    has_more: false,
  })
  expect(item.missed.items).toMatchObject([
    {
      ref: expect.stringMatching(new RegExp(`^meeting:${pbx}/\\d+$`)),
      started_at: "2026-11-02T22:30:00.000Z",
      outcome: "busy",
      client: { key: "phone:+34600000001" },
      called_back: true,
      callback: { after_ms: 8.5 * 3_600_000, direction: "incoming" },
    },
    { outcome: "voicemail", client: { key: "phone:+34600000003" }, called_back: false, callback: null },
    {
      outcome: "no_answer",
      client: { key: "phone:+34600000002" },
      called_back: true,
      callback: { after_ms: 1_800_000, direction: "outgoing" },
    },
  ])
})

it("narrows to a callback window and lists the newest missed calls only", async () => {
  const { store, pbx } = await seed()
  const { item } = await show(store, pbx, "--timezone", "Europe/Madrid", "--within", "1h", "--limit", "1")
  expect(item.calls).toBe(7)
  expect(item.callback_within_ms).toBe(3_600_000)
  expect(item.missed).toMatchObject({ calls: 3, called_back: 1, not_called_back: 2, has_more: true })
  expect(item.missed.items.map(({ outcome }: { outcome: string }) => outcome)).toEqual(["busy"])
})

it("says what a provider that keeps only recorded calls does not know, instead of counting it as zero", async () => {
  const { store, beeline } = await seed()
  const { item } = await show(store, beeline, "--timezone", "Europe/Madrid")
  expect(item).toMatchObject({
    calls: 2,
    known: { direction: 2, outcome: 0, wait_ms: 0, talk_ms: 0, duration_ms: 2, roles: 0 },
    by_direction: { incoming: 1, outgoing: 1, internal: 0, unknown: 0 },
    duration_ms: 240_000,
  })
  for (const absent of ["by_outcome", "talk_ms", "mean_talk_ms", "mean_wait_ms", "short_calls", "missed"])
    expect(item).not.toHaveProperty(absent)
  expect(item.employees).toEqual([
    {
      key: expect.stringMatching(/^identity:\d+$/),
      name: "Olga Test",
      identity_id: expect.any(Number),
      extension: "201",
      calls: 2,
      incoming: 1,
      outgoing: 1,
      internal: 0,
    },
  ])
  expect(item.days).toEqual([{ date: "2026-11-02", calls: 2, incoming: 1, outgoing: 1, internal: 0 }])
})

it("refuses an unknown zone and a callback window without a unit", async () => {
  const { store, pbx } = await seed()
  const definition = definitionFor(store, pbx)
  for (const args of [
    ["--timezone", "Mars/Olympus"],
    ["--within", "90"],
  ]) {
    const streams = captureStreams()
    const code = await run(["stats", "calls", "show", ...args, "--json", "--no-record"], definition, {
      streams,
      tty: false,
      env: {},
    })
    expect(code).not.toBe(0)
    expect(JSON.parse(streams.stderr.join("")).error.code).toBe("validation_error")
  }
})
