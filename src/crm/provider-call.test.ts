import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { Pacer } from "../sends/pace.js"
import { providerCall } from "./provider-call.js"

const failing = (...errors: unknown[]) => {
  let calls = 0
  return {
    send: async () => {
      calls += 1
      const next = errors.shift()
      if (next) throw next
      return "answer"
    },
    calls: () => calls,
  }
}
const waits: number[] = []
const sleep = async (ms: number) => {
  waits.push(ms)
}

describe("providerCall", () => {
  it("tries a read again on a retryable failure, a write never", async () => {
    const read = failing(new CliError("network_error", "cut", { retryable: true }))
    expect(await providerCall({ write: false, send: read.send, sleep, random: () => 0 })).toBe("answer")
    expect(read.calls()).toBe(2)
    const write = failing(new CliError("network_error", "cut", { retryable: true }))
    await expect(providerCall({ write: true, send: write.send, sleep })).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { retryable: false },
    })
    expect(write.calls()).toBe(1)
  })

  it("a write the CRM refused before sending stays what it was", async () => {
    const write = failing(new CliError("timeout", "no turn", { sent: false }))
    await expect(providerCall({ write: true, send: write.send, sleep })).rejects.toMatchObject({ code: "timeout" })
    const refused = failing(new CliError("validation_error", "bad field"))
    await expect(providerCall({ write: true, send: refused.send, sleep })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("tries a write again on rate_limited, holding the shared pace for the wait asked", async () => {
    const pacer = new Pacer(join(mkdtempSync(join(tmpdir(), "crm-pace-")), "pace.json"), { perMinute: 600, burst: 5 })
    const held: number[] = []
    const hold = pacer.holdFor.bind(pacer)
    pacer.holdFor = async (ms) => {
      held.push(ms)
      await hold(ms)
    }
    const write = failing(new CliError("rate_limited", "slow down", { retry_after_ms: 5 }))
    waits.length = 0
    expect(
      await providerCall({
        write: true,
        send: write.send,
        sleep,
        pace: { pacer, name: "Example CRM", operation: "contacts.add", sleep },
      }),
    ).toBe("answer")
    expect(held).toEqual([5])
    expect(waits).toContain(5)
  })

  it("refreshes the token once on oauth.expired, then gives up", async () => {
    let refreshes = 0
    const expired = () => new CliError("authentication_error", "expired", { reason: "oauth.expired" })
    const once = failing(expired())
    const refresh = async () => {
      refreshes += 1
      return true
    }
    expect(await providerCall({ write: true, send: once.send, refresh, sleep })).toBe("answer")
    const twice = failing(expired(), expired())
    await expect(providerCall({ write: false, send: twice.send, refresh, sleep })).rejects.toMatchObject({
      code: "authentication_error",
    })
    expect(refreshes).toBe(2)
    expect(twice.calls()).toBe(2)
  })

  it("stops after its retries and when the wait asked is longer than a run waits", async () => {
    const busy = () => new CliError("provider_unavailable", "busy", { retryable: true, retry_after_ms: 1 })
    const read = failing(busy(), busy(), busy())
    await expect(providerCall({ write: false, send: read.send, retries: 2, sleep })).rejects.toMatchObject({
      code: "provider_unavailable",
    })
    expect(read.calls()).toBe(3)
    const long = failing(new CliError("rate_limited", "later", { retry_after_ms: 120_000 }))
    await expect(providerCall({ write: false, send: long.send, sleep })).rejects.toMatchObject({ code: "rate_limited" })
  })
})
