import { afterEach, expect, it, vi } from "vitest"
import { endpointFetch } from "./endpoint.js"

afterEach(() => vi.unstubAllGlobals())

it("reaches the model address's own host and refuses a redirect to another one", async () => {
  const sent: string[] = []
  vi.stubGlobal("fetch", async (input: string | URL) => {
    sent.push(String(input))
    return String(input).startsWith("https://models.example.org/")
      ? new Response(null, { status: 307, headers: { location: "https://elsewhere.example.net/v1/embeddings" } })
      : new Response("{}")
  })
  const reach = endpointFetch("https://models.example.org/v1", 1000)

  await expect(reach("https://models.example.org/v1/embeddings", { method: "POST", body: "{}" })).rejects.toMatchObject(
    {
      details: { reason: "network.host-undeclared" },
    },
  )
  await expect(reach("https://elsewhere.example.net/v1/embeddings")).rejects.toMatchObject({
    details: { reason: "network.host-undeclared" },
  })
  expect(sent).toEqual(["https://models.example.org/v1/embeddings"])
})

it("**reaches an IPv6 model address the owner set**, as an IPv4 one, and only that host", async () => {
  const sent: string[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    sent.push(url)
    return url.includes("/moved")
      ? new Response(null, { status: 307, headers: { location: "https://elsewhere.example.net/v1" } })
      : new Response("{}")
  })
  const reach = endpointFetch("https://[fd00::1]:8443/v1", 1000)

  expect((await reach("https://[fd00::1]:8443/v1/embeddings", { method: "POST", body: "{}" })).status).toBe(200)
  await expect(reach("https://[fd00::2]:8443/v1/embeddings")).rejects.toMatchObject({
    details: { reason: "network.host-undeclared" },
  })
  await expect(reach("https://[fd00::1]:8443/v1/moved")).rejects.toMatchObject({ code: "invalid_response" })
  expect(sent).toEqual(["https://[fd00::1]:8443/v1/embeddings", "https://[fd00::1]:8443/v1/moved"])
})

it("gives up on an IPv6 model address after its deadline", async () => {
  vi.stubGlobal(
    "fetch",
    (_input: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
  )

  await expect(endpointFetch("https://[fd00::1]/v1", 10)("https://[fd00::1]/v1/chat")).rejects.toMatchObject({
    code: "timeout",
  })
})
