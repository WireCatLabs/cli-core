import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { SendGuard } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import type { SendEntry } from "../sends/journal.js"
import { withDeadline } from "./deadline.js"

const recording = () => {
  const entries: Omit<SendEntry, "at" | "profile">[] = []
  const guard = {
    check: () => {},
    record: (entry: Omit<SendEntry, "at" | "profile">) => {
      entries.push(entry)
    },
  } as unknown as SendGuard
  return { guard, entries }
}

const never = () => new Promise<never>(() => {})

describe("a deadline that ends the command", () => {
  it("**cuts a write in flight into an unknown outcome**, never a plain timeout, and journals it once", async () => {
    const { guard, entries } = recording()
    const cut = withDeadline(20, [], () =>
      guardedWrite(guard, { operationId: "op-1", chatId: "-100", kind: "message" }, never),
    )

    await expect(cut).rejects.toMatchObject({ code: "outcome_unknown", details: { operationIds: ["op-1"] } })
    expect(entries).toEqual([
      {
        operationId: "op-1",
        chatId: "-100",
        kind: "message",
        outcome: "outcome_unknown",
        errorCode: "outcome_unknown",
      },
    ])
  })

  it("cancels topic preflight as a timeout and never sends after a late answer", async () => {
    const { guard, entries } = recording()
    let release = () => {}
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = vi.fn(async () => "sent")
    let body: Promise<string> | undefined
    const expired = withDeadline(1, [], () => {
      body = guardedWrite(
        guard,
        { operationId: "op-topic", chatId: "-100", kind: "message", threadId: "12" },
        send,
        () => ({}),
        () => ready,
      )
      return body
    })
    await expect(expired).rejects.toMatchObject({ code: "timeout" })
    release()
    await expect(body).rejects.toMatchObject({ code: "timeout" })
    expect(send).not.toHaveBeenCalled()
    expect(entries).toMatchObject([
      { operationId: "op-topic", threadId: "12", outcome: "failed", errorCode: "timeout" },
    ])
    expect(entries).toHaveLength(1)
  })

  it("says timeout when nothing was being written", async () => {
    await expect(withDeadline(20, [], never)).rejects.toMatchObject({ code: "timeout" })
  })

  it("leaves alone a write that was answered before the deadline", async () => {
    const { guard, entries } = recording()
    const done = await withDeadline(1000, [], () =>
      guardedWrite(guard, { operationId: "op-2", chatId: "-100", kind: "message" }, async () => "sent"),
    )

    expect(done).toBe("sent")
    expect(entries).toMatchObject([{ operationId: "op-2", outcome: "sent" }])
  })
})

it("does not reserve or send a new write after its scope has timed out", async () => {
  let release = () => {}
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  const check = vi.fn()
  const send = vi.fn(async () => "sent")
  const guard: SendGuard = { check, record: () => {} }
  let continued: Promise<string> | undefined
  await expect(
    withDeadline(5, [], () => {
      continued = (async () => {
        await delayed
        return guardedWrite(guard, { operationId: "op-late", chatId: "synthetic", kind: "message" }, send)
      })()
      return continued
    }),
  ).rejects.toMatchObject({ code: "timeout" })
  release()
  await expect(continued).rejects.toMatchObject({ code: "timeout" })
  expect(check).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it("correlates provider unknown outcomes with the guarded operation id", async () => {
  const { guard, entries } = recording()
  await expect(
    guardedWrite(guard, { operationId: "op-provider", chatId: "synthetic", kind: "message" }, async () => {
      throw new CliError("outcome_unknown", "synthetic", { sendId: "synthetic-send" })
    }),
  ).rejects.toMatchObject({
    code: "outcome_unknown",
    details: { operationId: "op-provider", sendId: "synthetic-send", retryable: false },
  })
  expect(entries).toHaveLength(1)
})
