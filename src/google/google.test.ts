import { describe, expect, it } from "vitest"
import { googleError, googlePages } from "./index.js"

const legacy = (reason: string) => ({ error: { errors: [{ reason }] } })
const rpc = (reason: string, status?: string) => ({
  error: { status, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] },
})

describe("googleError", () => {
  it.each([
    [401, {}, false, "authentication_error", "oauth.expired"],
    [403, legacy("accessNotConfigured"), false, "configuration_error", "api.disabled"],
    [403, rpc("SERVICE_DISABLED"), false, "configuration_error", "api.disabled"],
    [403, legacy("insufficientPermissions"), false, "permission_error", "oauth.scope-missing"],
    [403, rpc("ACCESS_TOKEN_SCOPE_INSUFFICIENT"), false, "permission_error", "oauth.scope-missing"],
    [403, legacy("quotaExceeded"), false, "rate_limited", "provider.usage-limit"],
    [403, legacy("forbiddenForNonOrganizer"), true, "permission_error", "event.organizer-only"],
    [403, {}, false, "permission_error", "access.denied"],
    [404, {}, false, "not_found", "item.not-found"],
  ])("HTTP %i %j answers %s", (status, body, mutates, code, reason) => {
    expect(googleError({ status, body, mutates })).toMatchObject({ code, details: { reason, status } })
  })

  it("a rate limit is retryable, even for a write, and carries the wait", () => {
    expect(googleError({ status: 429, body: {}, mutates: true, retryAfterMs: 2000 })).toMatchObject({
      code: "rate_limited",
      details: { retryable: true, retry_after_ms: 2000 },
    })
    expect(
      googleError({ status: 429, body: rpc("RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED"), mutates: false }).code,
    ).toBe("rate_limited")
    expect(googleError({ status: 403, body: legacy("userRateLimitExceeded"), mutates: false }).code).toBe(
      "rate_limited",
    )
  })

  it("a server failure is retryable for a read and of unknown outcome for a write", () => {
    expect(googleError({ status: 503, body: null, mutates: false })).toMatchObject({
      details: { retryable: true, status: 503 },
    })
    expect(googleError({ status: 500, body: null, mutates: true })).toMatchObject({
      code: "outcome_unknown",
      details: { retryable: false },
    })
  })

  it("names the service and never repeats Google's message", () => {
    const body = { error: { message: "secret meeting title", errors: [{ reason: "notFound" }] } }
    const error = googleError({ status: 404, body, mutates: false, service: "Google Meet" })
    expect(error.message).toBe("Google Meet has no such item, or this account cannot see it")
    expect(googleError({ status: 400, body, mutates: false }).message).toBe("Google refused the request (HTTP 400)")
    expect(
      googleError({ status: 403, body: legacy("quotaExceeded"), mutates: false, errorsGuide: "https://guide" }).message,
    ).toContain("(https://guide)")
  })
})

describe("googlePages", () => {
  it("reads every page in order", async () => {
    const pages: Record<string, { items: number[]; nextPageToken?: string }> = {
      "": { items: [1, 2], nextPageToken: "a" },
      a: { items: [3], nextPageToken: "b" },
      b: { items: [] },
    }
    const asked: (string | undefined)[] = []
    const items = await googlePages("records", async (token) => {
      asked.push(token)
      return pages[token ?? ""] ?? {}
    })
    expect(items).toEqual([1, 2, 3])
    expect(asked).toEqual([undefined, "a", "b"])
  })

  it("refuses a repeated page token", async () => {
    let calls = 0
    const loop = googlePages("records", async () => {
      calls++
      return { items: [calls], nextPageToken: "a" }
    })
    await expect(loop).rejects.toMatchObject({ code: "invalid_response" })
    expect(calls).toBe(2)
  })

  it("refuses a list past its page limit", async () => {
    let calls = 0
    const endless = googlePages("records", async () => ({ nextPageToken: String(++calls) }), 3)
    await expect(endless).rejects.toMatchObject({ code: "invalid_response", message: expect.stringContaining("3") })
  })
})
