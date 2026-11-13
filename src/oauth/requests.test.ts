import { afterEach, describe, expect, it, vi } from "vitest"
import type { OAuthProvider, RequestContext } from "./provider.js"
import { requestTokens, revokeToken } from "./requests.js"

const provider: OAuthProvider = {
  id: "test",
  name: "Test",
  authorizeUrl: "https://example.test/authorize",
  tokenUrl: "https://example.test/token",
  revokeUrl: "https://example.test/revoke",
  client: { clientId: "client" },
  redirect: { kind: "loopback" },
}

const contextFor = (fetch: typeof globalThis.fetch): RequestContext => ({
  fetch,
  client: provider.client,
  now: () => 0,
  signInCommand: "test sign-in",
})

afterEach(() => vi.useRealTimers())

describe("the request time limit", () => {
  it("stops its timer once the token answer is read", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | null | undefined
    const answer: typeof fetch = async (_url, init) => {
      signal = init?.signal
      expect(vi.getTimerCount()).toBe(1)
      return Response.json({ access_token: "a", refresh_token: "r", expires_in: 60 })
    }
    await requestTokens(provider, { grant_type: "refresh_token" }, contextFor(answer))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(signal?.aborted).toBe(false)
  })

  it("stops its timer after a revoke", async () => {
    vi.useFakeTimers()
    const answer: typeof fetch = async () => new Response(null, { status: 200 })
    await revokeToken(provider, { refreshToken: "r", scopes: [] }, contextFor(answer))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still gives up on a request that never answers", async () => {
    vi.useFakeTimers()
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
    const outcome = expect(
      requestTokens(provider, { grant_type: "refresh_token" }, contextFor(hanging)),
    ).rejects.toMatchObject({ code: "outcome_unknown" })
    await vi.advanceTimersByTimeAsync(30_000)
    await outcome
  })
})

describe("revokeToken", () => {
  const revokeAnswering = (status: number, body: string) =>
    revokeToken(
      provider,
      { refreshToken: "r", scopes: [] },
      contextFor(async () => new Response(body, { status })),
    )

  it("takes Google's 400 invalid_token as a sign-in already taken back", async () => {
    await expect(revokeAnswering(400, JSON.stringify({ error: "invalid_token" }))).resolves.toBeUndefined()
  })

  it("still refuses every other 400 and any other failure", async () => {
    for (const [status, body] of [
      [400, JSON.stringify({ error: "invalid_request" })],
      [400, "not json"],
      [400, ""],
      [401, JSON.stringify({ error: "invalid_token" })],
      [500, ""],
    ] as const)
      await expect(revokeAnswering(status, body)).rejects.toMatchObject({
        code: "outcome_unknown",
        details: { reason: "oauth.revoke-failed", status },
      })
  })
})
