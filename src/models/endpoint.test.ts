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
