import { CliError, captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { guardedWrite, writesInFlight } from "../sends/guarded.js"
import { withDeadline } from "./deadline.js"
import { byteCount, execution } from "./execution.js"

describe("bounded command execution", () => {
  it("counts UTF-8 bytes and keeps an oversized JSON document off stdout", async () => {
    const streams = captureStreams()
    const control = execution(streams, { maxOutputBytes: 6 })
    expect(() => control.streams.data('"ééé"')).toThrow("output exceeds")
    expect(streams.stdout).toEqual([])
    control.configure({ maxOutputBytes: 0, fields: "id" })
    control.streams.data('{"id":"1","text":"private","operationId":"op-1"}')
    expect(JSON.parse(streams.stdout[0] ?? "")).toEqual({ id: "1", operationId: "op-1" })
    await control.finish()
    control.streams.data("late")
    control.streams.diagnostic("late")
    expect(streams.stdout).toHaveLength(1)
    expect(streams.stderr).toEqual([])
  })

  it("marks complete earlier JSONL rows as partial when the next row exceeds the budget", async () => {
    const streams = captureStreams()
    const control = execution(streams, { maxOutputBytes: 5 })
    control.streams.data("{}")
    try {
      control.streams.data("{}")
    } catch (error) {
      expect((error as CliError).details).toMatchObject({ partialOutput: true, emittedBytes: 3, retryable: false })
    }
    expect(streams.stdout).toEqual(["{}"])
    await control.finish()
  })

  it("ends hung work and closes its resources even when close rejects", async () => {
    let closed = 0
    const control = execution(captureStreams(), { timeoutMs: 5 })
    control.trackCloseable({
      close: async () => {
        closed++
        throw new Error("synthetic close failure")
      },
    })
    await expect(control.race(() => new Promise(() => {}))).rejects.toMatchObject({ code: "timeout" })
    expect(control.signal.aborted).toBe(true)
    await control.finish()
    expect(closed).toBeGreaterThan(0)
  })

  it("cuts an outstanding write as outcome unknown and never offers replay", async () => {
    let cuts = 0
    const control = execution(captureStreams(), { timeoutMs: 5 })
    await expect(
      control.race(async () => {
        writesInFlight.getStore()?.add({
          operationId: "op-synthetic",
          cut: () => {
            cuts++
          },
        })
        return new Promise(() => {})
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown", details: { retryable: false, operationIds: ["op-synthetic"] } })
    expect(cuts).toBe(1)
    await control.finish()
  })

  it("keeps a command's own unknown outcome when the deadline stops it", async () => {
    const control = execution(captureStreams(), { timeoutMs: 5 })
    const own = new CliError("outcome_unknown", "synthetic write got no answer")
    await expect(
      control.race(
        () =>
          new Promise((_, reject) => {
            control.signal.addEventListener("abort", () => reject(own), { once: true })
          }),
      ),
    ).rejects.toBe(own)
    expect(control.failure()).toBe(own)
  })

  it("keeps a write that was still preparing as a definite timeout", async () => {
    const control = execution(captureStreams(), { timeoutMs: 5 })
    await expect(
      control.race(async () => {
        writesInFlight.getStore()?.add({ operationId: "op-preparing", preparing: true, cut: () => {} })
        return new Promise(() => {})
      }),
    ).rejects.toMatchObject({ code: "timeout" })
    await control.finish()
  })

  it("rejects projection of non-JSON and validates byte counts", async () => {
    const control = execution(captureStreams(), { fields: "id" })
    expect(() => control.streams.data("plain text")).toThrow("not a JSON result")
    for (const value of ["-1", "0", "12x", "9007199254740993"]) expect(() => byteCount(value, "--bytes")).toThrow()
    expect(byteCount("0", "--bytes", true)).toBe(0)
    expect(byteCount("42", "--bytes")).toBe(42)
    await control.finish()
  })
})

it("sees writes inside an inner deadline and stops later writes across the whole command", async () => {
  const control = execution(captureStreams(), { timeoutMs: 5 })
  const guard = { check: () => {}, record: () => {} }
  await expect(
    control.race(() =>
      withDeadline(1000, [], () =>
        guardedWrite(
          guard,
          { operationId: "op-nested", chatId: "synthetic", kind: "message" },
          () => new Promise(() => {}),
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: "outcome_unknown", details: { operationIds: ["op-nested"] } })
  await control.finish()
})
