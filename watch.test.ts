import { afterEach, expect, it, vi } from "vitest"
import { importFiles } from "./import.js"
import type { RunReport } from "./pull.js"
import { memoryMeetingStore } from "./testing/index.js"
import { sampleMeeting } from "./testing/samples.js"
import { watchMeetingIngestion } from "./watch.js"

const report = (meetings = 1): RunReport => ({
  meetings,
  participants: 0,
  transcriptRows: 1,
  summaries: 0,
  warnings: [],
})
afterEach(() => {
  vi.useRealTimers()
})

it("validates bounded integer intervals before starting ingestion", async () => {
  for (const intervalMs of [0, -1, 999, 1000.5, 86400001, Number.NaN, Number.POSITIVE_INFINITY]) {
    let calls = 0
    const watch = watchMeetingIngestion(
      async () => {
        calls++
        return report()
      },
      { signal: new AbortController().signal, intervalMs },
    )
    await expect(watch.next()).rejects.toMatchObject({ code: "validation_error" })
    expect(calls).toBe(0)
  }
  const abort = new AbortController()
  abort.abort()
  expect(
    await watchMeetingIngestion(
      async () => {
        throw new Error("unexpected ingestion")
      },
      { signal: abort.signal, intervalMs: 86400000 },
    ).next(),
  ).toEqual({ done: true, value: undefined })
})
it("runs immediately and uses receipt backpressure and completion-relative waiting", async () => {
  const abort = new AbortController()
  const calls: string[] = []
  let count = 0
  const watch = watchMeetingIngestion(
    async (signal) => {
      expect(signal).toBe(abort.signal)
      calls.push(`ingest ${++count}`)
      return report(count)
    },
    {
      signal: abort.signal,
      intervalMs: 1000,
      sleep: async (ms, signal) => {
        expect(ms).toBe(1000)
        expect(signal).toBe(abort.signal)
        calls.push("wait")
      },
    },
  )
  expect((await watch.next()).value).toEqual(report(1))
  expect(calls).toEqual(["ingest 1"])
  expect((await watch.next()).value).toEqual(report(2))
  expect(calls).toEqual(["ingest 1", "wait", "ingest 2"])
  await watch.return()
  expect(calls).toEqual(["ingest 1", "wait", "ingest 2"])
})
it("keeps in-flight callbacks serial even when the consumer queues next requests", async () => {
  const abort = new AbortController()
  let finish: (value: RunReport) => void = () => {}
  let active = 0
  let maximum = 0
  let cycles = 0
  const watch = watchMeetingIngestion(
    async () => {
      maximum = Math.max(maximum, ++active)
      cycles++
      const result = await new Promise<RunReport>((resolve) => {
        finish = resolve
      })
      active--
      return result
    },
    { signal: abort.signal, intervalMs: 1000, sleep: async () => {} },
  )
  const first = watch.next()
  const second = watch.next()
  await Promise.resolve()
  expect(cycles).toBe(1)
  finish(report(1))
  expect((await first).value).toEqual(report(1))
  await Promise.resolve()
  expect(cycles).toBe(2)
  abort.abort()
  finish(report(2))
  expect((await second).value).toEqual(report(2))
  expect(await watch.next()).toEqual({ done: true, value: undefined })
  expect(maximum).toBe(1)
})
it("uses a real cancellable timer without leaving listeners or pending waits", async () => {
  vi.useFakeTimers()
  const abort = new AbortController()
  let calls = 0
  const watch = watchMeetingIngestion(
    async () => {
      calls++
      return report(calls)
    },
    { signal: abort.signal, intervalMs: 1000 },
  )
  await watch.next()
  const next = watch.next()
  await vi.advanceTimersByTimeAsync(1000)
  expect((await next).value).toEqual(report(2))
  const waiting = watch.next()
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(1)
  abort.abort()
  expect(await waiting).toEqual({ done: true, value: undefined })
  expect(vi.getTimerCount()).toBe(0)
  expect(calls).toBe(2)
})
it("stops on aborted waits and aborted ingestion without starting another cycle", async () => {
  for (const phase of ["ingest", "wait"]) {
    const abort = new AbortController()
    let calls = 0
    const cancel = new DOMException("Example cancellation", "AbortError")
    const watch = watchMeetingIngestion(
      async () => {
        calls++
        if (phase === "ingest") {
          abort.abort(cancel)
          throw cancel
        }
        return report()
      },
      {
        signal: abort.signal,
        intervalMs: 1000,
        sleep: async () => {
          abort.abort(cancel)
          throw cancel
        },
      },
    )
    if (phase === "wait") await watch.next()
    expect(await watch.next()).toEqual({ done: true, value: undefined })
    expect(calls).toBe(1)
  }
  const abort = new AbortController()
  const watch = watchMeetingIngestion(
    async () => {
      abort.abort()
      throw Object.assign(new Error("Example cancellation"), { code: "cancelled" })
    },
    { signal: abort.signal, intervalMs: 1000 },
  )
  expect(await watch.next()).toEqual({ done: true, value: undefined })
})
it("propagates callback or wait failures and does not hide unrelated errors during cancellation", async () => {
  for (const phase of ["ingest", "wait"]) {
    const failure = new Error("Example failure")
    const watch = watchMeetingIngestion(
      async () => {
        if (phase === "ingest") throw failure
        return report()
      },
      {
        signal: new AbortController().signal,
        intervalMs: 1000,
        sleep: async () => {
          throw failure
        },
      },
    )
    if (phase === "wait") await watch.next()
    await expect(watch.next()).rejects.toBe(failure)
  }
  const abort = new AbortController()
  const failure = Object.assign(new Error("Example uncertain outcome"), { code: "outcome_unknown", name: "AbortError" })
  const watch = watchMeetingIngestion(
    async () => {
      abort.abort(failure)
      throw failure
    },
    { signal: abort.signal, intervalMs: 1000 },
  )
  await expect(watch.next()).rejects.toBe(failure)
  const unrelated = new Error("Example separate failure")
  const second = new AbortController()
  const other = watchMeetingIngestion(
    async () => {
      second.abort()
      throw unrelated
    },
    { signal: second.signal, intervalMs: 1000 },
  )
  await expect(other.next()).rejects.toBe(unrelated)
})
it("rereads corrected input through the callback and retains existing transcript history", async () => {
  const store = memoryMeetingStore()
  const abort = new AbortController()
  let cycle = 0
  const watch = watchMeetingIngestion(
    async () => {
      cycle++
      const file = {
        meeting: sampleMeeting().meeting,
        content: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAlice Example: Example plan\n",
      }
      if (cycle === 2) file.content = file.content.replace("Example plan", "Corrected example plan")
      return importFiles([file], store)
    },
    { signal: abort.signal, intervalMs: 1000, sleep: async () => {} },
  )
  expect((await watch.next()).value?.meetings).toBe(1)
  expect((await watch.next()).value?.meetings).toBe(1)
  abort.abort()
  await watch.next()
  const meetings = await store.meetings()
  expect(meetings).toHaveLength(1)
  expect((await store.meeting(meetings[0]?.id ?? 0))?.transcripts).toHaveLength(2)
})

it("recognizes typed cancellation but preserves an unrelated error merely named AbortError", async () => {
  for (const error of [
    new DOMException("Example timeout", "TimeoutError"),
    Object.assign(new Error("Example wait cancellation"), { code: "ABORT_ERR" }),
  ]) {
    const abort = new AbortController()
    const watch = watchMeetingIngestion(
      async () => {
        abort.abort()
        throw error
      },
      { signal: abort.signal, intervalMs: 1000 },
    )
    expect(await watch.next()).toEqual({ done: true, value: undefined })
  }
  const abort = new AbortController()
  const unrelated = Object.assign(new Error("Example independent failure"), { name: "AbortError" })
  const watch = watchMeetingIngestion(
    async () => {
      abort.abort()
      throw unrelated
    },
    { signal: abort.signal, intervalMs: 1000 },
  )
  await expect(watch.next()).rejects.toBe(unrelated)
})
