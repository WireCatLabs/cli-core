import { CliError } from "@wirecat/cli-base"
import { expect, it, vi } from "vitest"
import {
  installRecordingArchiveSchedule,
  parseRecordingArchiveSchedule,
  planRecordingArchiveSchedule,
  recordingArchiveScheduleWindow,
} from "./recording-schedule.js"

const now = Date.parse("2026-10-11T12:00:00.000Z")
const input = () => ({
  name: "Alice Example archive",
  scope: { provider: "sample-a", account: "alice-example" },
  destination: "memory:archive",
  from: "2026-01-01",
  dailyAt: "03:15",
  timeZone: "Europe/Madrid",
})
const planned = () => planRecordingArchiveSchedule(input(), { now })

it("snapshots portable definitions and stable identity without host or provider IO", () => {
  const options = input()
  const schedule = planRecordingArchiveSchedule(options, { now })
  options.scope.account = "bob-sample"
  expect(schedule.scope.account).toBe("alice-example")
  expect(schedule).toMatchObject({ version: 1, lookbackDays: 7, maxBytes: 20 * 1024 ** 3, createdAt: now })
  expect(Object.isFrozen(schedule)).toBe(true)
  expect(Object.isFrozen(schedule.scope)).toBe(true)
  expect(planRecordingArchiveSchedule(input(), { now: now + 1000 }).id).toBe(schedule.id)
  expect(parseRecordingArchiveSchedule(JSON.parse(JSON.stringify(schedule)))).toEqual(schedule)
})

it.each(["sample-a", "sample-b"])("installs a %s job only after explicit apply", async (provider) => {
  const schedule = planRecordingArchiveSchedule(
    { ...input(), scope: { provider, account: "bob-sample" }, lookbackDays: 0, maxBytes: 100 },
    { now },
  )
  const install = vi.fn(async () => {})
  const scheduler = { backend: "invented-scheduler", install }
  expect(await installRecordingArchiveSchedule(scheduler, schedule)).toMatchObject({ applied: false })
  expect(await installRecordingArchiveSchedule(scheduler, schedule, { apply: true, dryRun: true })).toMatchObject({
    applied: false,
  })
  expect(install).not.toHaveBeenCalled()
  expect(await installRecordingArchiveSchedule(scheduler, schedule, { apply: true })).toMatchObject({
    applied: true,
    schedule,
  })
  expect(install).toHaveBeenCalledExactlyOnceWith(schedule, { signal: undefined })
})

it("retains a committed installation acknowledgement after late cancellation", async () => {
  const controller = new AbortController()
  const scheduler = {
    backend: "first",
    install: async () => {
      scheduler.backend = "changed"
      controller.abort()
    },
  }
  expect(
    await installRecordingArchiveSchedule(scheduler, planned(), { apply: true, signal: controller.signal }),
  ).toMatchObject({ applied: true, backend: "first" })
  const install = vi.fn(async () => {})
  await expect(
    installRecordingArchiveSchedule({ backend: "unused", install }, planned(), {
      apply: true,
      signal: controller.signal,
    }),
  ).rejects.toThrow()
  expect(install).not.toHaveBeenCalled()
})

it("does not report failed installation as success or retry it", async () => {
  const error = new Error("invented scheduler failure")
  const install = vi.fn(async () => {
    throw error
  })
  await expect(
    installRecordingArchiveSchedule({ backend: "sample", install }, planned(), { apply: true }),
  ).rejects.toBe(error)
  expect(install).toHaveBeenCalledOnce()
})

it("preserves typed cancellation and translates timeout before installation", async () => {
  const install = vi.fn(async () => {})
  const scheduler = { backend: "sample", install }
  const reason = new CliError("cancelled", "invented cancellation")
  await expect(
    installRecordingArchiveSchedule(scheduler, planned(), { apply: true, signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason)
  await expect(
    installRecordingArchiveSchedule(scheduler, planned(), {
      apply: true,
      signal: AbortSignal.abort(new DOMException("invented timeout", "TimeoutError")),
    }),
  ).rejects.toMatchObject({ code: "timeout" })
  expect(install).not.toHaveBeenCalled()
})

it("uses discovery dates with bounded overlap and initial/future start boundaries", () => {
  expect(recordingArchiveScheduleWindow(planned(), { now })).toEqual({
    from: "2026-01-01",
    to: "2026-10-11",
    recheckFrom: "2026-10-04",
  })
  expect(
    recordingArchiveScheduleWindow(planRecordingArchiveSchedule({ ...input(), from: "2026-10-10" }, { now }), { now })
      ?.recheckFrom,
  ).toBe("2026-10-10")
  expect(
    recordingArchiveScheduleWindow(planRecordingArchiveSchedule({ ...input(), lookbackDays: 0 }, { now }), { now })
      ?.recheckFrom,
  ).toBe("2026-10-11")
  expect(
    recordingArchiveScheduleWindow(planRecordingArchiveSchedule({ ...input(), from: "2027-01-01" }, { now }), { now }),
  ).toBeNull()
})

it("counts today in the schedule's own zone, not in UTC", () => {
  const evening = Date.parse("2026-10-21T15:30:00.000Z")
  const schedule = planRecordingArchiveSchedule({ ...input(), timeZone: "Asia/Vladivostok" }, { now: evening })
  expect(recordingArchiveScheduleWindow(schedule, { now: evening })?.to).toBe("2026-10-22")
  expect(recordingArchiveScheduleWindow(planned(), { now: evening })?.to).toBe("2026-10-21")
})

it("keeps long-lived discovery within ten calendar years across leap days", () => {
  const schedule = planRecordingArchiveSchedule(
    { ...input(), from: "2010-03-01" },
    { now: Date.parse("2020-02-29T00:00:00.000Z") },
  )
  expect(recordingArchiveScheduleWindow(schedule, { now: Date.parse("2024-02-29T12:00:00.000Z") })?.from).toBe(
    "2014-02-28",
  )
})

it.each([
  { name: "" },
  { name: "a\nb" },
  { destination: "\0" },
  { destination: "a".repeat(4097) },
  { dailyAt: "3:15" },
  { dailyAt: "24:00" },
  { dailyAt: "12:60" },
  { timeZone: "" },
  { timeZone: "invented/not-a-zone" },
  { from: "2026-02-30" },
  { from: "2010-01-01" },
  { lookbackDays: -1 },
  { lookbackDays: 32 },
  { lookbackDays: 1.5 },
  { maxBytes: 0 },
  { maxBytes: Infinity },
])("rejects invalid inputs before host work: %j", (change) => {
  expect(() => planRecordingArchiveSchedule({ ...input(), ...change }, { now })).toThrow()
})

it.each([-1, Infinity, 253402300800000])("rejects invalid clock %s", (value) => {
  expect(() => planRecordingArchiveSchedule(input(), { now: value })).toThrow()
  expect(() => recordingArchiveScheduleWindow(planned(), { now: value })).toThrow()
})

it.each([
  null,
  [],
  { ...planned(), version: 2 },
  { ...planned(), id: "different" },
  { ...planned(), token: "invented-disallowed-field" },
])("rejects malformed or tampered persisted definitions", (value) => {
  expect(() => parseRecordingArchiveSchedule(value)).toThrow()
})
