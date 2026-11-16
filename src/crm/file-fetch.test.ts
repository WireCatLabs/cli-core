import type { FetchLike } from "@wirecat/cli-base/http"
import { describe, expect, it } from "vitest"
import { fetchCrmFile } from "./file-fetch.js"

const TOKEN = "secret-token-1"
const HOSTS = ["portal.example"]

/** A file server: each URL's answer, and every request it was sent with its headers. */
const server = (answers: Record<string, () => Response>) => {
  const sent: { url: string; auth: string | null }[] = []
  const send: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    sent.push({ url: url.href, auth: new Headers(init?.headers).get("authorization") })
    const answer = answers[url.href]
    if (!answer) throw new Error(`fetch failed: ${url.href}`)
    return answer()
  }
  return { send, sent }
}

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

describe("fetchCrmFile", () => {
  it("follows a redirect on the account's own host and sends the credentials only there", async () => {
    const { send, sent } = server({
      [`https://portal.example/a?token=${TOKEN}`]: () =>
        new Response(null, { status: 302, headers: { location: "/b" } }),
      "https://portal.example/b": () => new Response("file bytes", { headers: { "content-type": "application/pdf" } }),
    })
    const body = await fetchCrmFile(`https://portal.example/a?token=${TOKEN}`, {
      hosts: HOSTS,
      headers: { authorization: "Bearer x" },
      fetch: send,
    })
    expect(await text(body)).toBe("file bytes")
    expect(sent.map((one) => one.auth)).toEqual(["Bearer x", "Bearer x"])
  })

  it("closes each redirect's body before the next hop", async () => {
    let cancelled = 0
    const body = () =>
      new ReadableStream({
        cancel: () => {
          cancelled += 1
        },
      })
    const { send } = server({
      "https://portal.example/a": () => new Response(body(), { status: 302, headers: { location: "/b" } }),
      "https://portal.example/b": () => new Response("file bytes"),
    })
    await text(await fetchCrmFile("https://portal.example/a", { hosts: HOSTS, fetch: send }))
    expect(cancelled).toBe(1)
  })

  it.each([
    ["http", `http://portal.example/a?token=${TOKEN}`, {}],
    ["another host", `https://evil.example/a?token=${TOKEN}`, {}],
    [
      "a redirect to another host",
      `https://portal.example/r?token=${TOKEN}`,
      {
        [`https://portal.example/r?token=${TOKEN}`]: () =>
          new Response(null, { status: 302, headers: { location: `https://evil.example/x?token=${TOKEN}` } }),
      },
    ],
    [
      "a web page",
      `https://portal.example/p?token=${TOKEN}`,
      {
        [`https://portal.example/p?token=${TOKEN}`]: () =>
          new Response("<html>", { headers: { "content-type": "text/html" } }),
      },
    ],
    ["a network failure", `https://portal.example/down?token=${TOKEN}`, {}],
    [
      "a server error",
      `https://portal.example/500?token=${TOKEN}`,
      { [`https://portal.example/500?token=${TOKEN}`]: () => new Response("no", { status: 500 }) },
    ],
  ] as const)("refuses %s without naming the link", async (_why, link, answers) => {
    const { send, sent } = server(answers as Record<string, () => Response>)
    const error = await fetchCrmFile(link, { hosts: HOSTS, fetch: send }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ details: { reason: "crm.file-unavailable" } })
    expect(`${(error as Error).message}${JSON.stringify(error)}`).not.toContain(TOKEN)
    expect(sent.every((one) => new URL(one.url).hostname === "portal.example")).toBe(true)
  })
})
