import { readFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { allowNetwork } from "@wirecat/cli-base/testing"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { registerReader } from "../readers/registry.js"
import { isPublicAddress } from "./addresses.js"
import {
  type FetchPageOptions,
  fetchPage,
  nodeTransport,
  PAGE_USER_AGENT,
  type PageRequest,
  type PageResponse,
  type ResolvedAddress,
} from "./page.js"

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 }

const answer = (status: number, headers: Record<string, string> = {}, ...chunks: (string | Uint8Array)[]) => {
  const cancel = vi.fn()
  return {
    status,
    header: (name: string) => headers[name.toLowerCase()] ?? null,
    body: (async function* () {
      for (const chunk of chunks) yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
    })(),
    cancel,
  } satisfies PageResponse
}

const html = (text: string) => answer(200, { "content-type": "text/html; charset=utf-8" }, text)

const site = (route: (request: PageRequest) => PageResponse | Promise<PageResponse>, lookup = async () => [PUBLIC]) => {
  const requests: PageRequest[] = []
  const options: FetchPageOptions = {
    lookup: vi.fn(lookup),
    transport: async (request) => {
      requests.push(request)
      return route(request)
    },
  }
  return { requests, options }
}

const refusal = (reason: string, extra: Record<string, unknown> = {}) =>
  expect.objectContaining({ details: expect.objectContaining({ reason, ...extra }) })

afterEach(() => {
  vi.useRealTimers()
})

describe("which addresses are on the public internet", () => {
  it.each([
    ["93.184.216.34", true],
    ["2606:4700:4700::1111", true],
    ["::ffff:93.184.216.34", true],
    ["2002:5db8:d822::1", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.20.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["100.127.255.255", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::", false],
    ["::1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["64:ff9b::a00:1", false],
    ["2002:a00:1::", false],
    ["fd00::1", false],
    ["fe80::1%eth0", false],
    ["ff02::1", false],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["not-an-address", false],
  ])("%s is public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })
})

describe("fetchPage refuses", () => {
  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.1/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::1]:8080/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://[fd12::1]/",
    "not a link",
  ])("%s before any connection", async (link) => {
    const { requests, options } = site(() => html("<p>never</p>"))
    await expect(fetchPage(link, options)).rejects.toEqual(refusal("source.url-refused"))
    expect(requests).toEqual([])
  })

  it("a name with any private address among its answers", async () => {
    const { requests, options } = site(
      () => html("<p>never</p>"),
      async () => [PUBLIC, { address: "10.0.0.5", family: 4 }],
    )
    await expect(fetchPage("https://mixed.example/", options)).rejects.toEqual(refusal("source.url-refused"))
    expect(requests).toEqual([])
  })

  it("a name that turns private on the next lookup (DNS rebinding), checked again at the redirect", async () => {
    const answers = [[PUBLIC], [{ address: "127.0.0.1", family: 4 as const }]]
    const { requests, options } = site(
      () => answer(302, { location: "/admin" }),
      async () => answers.shift() ?? [],
    )
    await expect(fetchPage("https://rebind.example/start", options)).rejects.toEqual(refusal("source.url-refused"))
    expect(requests.map(({ url, address }) => [url.pathname, address.address])).toEqual([["/start", PUBLIC.address]])
  })

  it("a redirect to 127.0.0.1", async () => {
    const { requests, options } = site(() => answer(301, { location: "http://127.0.0.1:2375/containers" }))
    await expect(fetchPage("https://example.com/", options)).rejects.toEqual(refusal("source.url-refused"))
    expect(requests).toHaveLength(1)
  })

  it("a sixth redirect, after following five", async () => {
    const { requests, options } = site(({ url }) =>
      answer(302, { location: `/hop${Number(url.pathname.slice(4) || 0) + 1}` }),
    )
    await expect(fetchPage("https://example.com/hop0", options)).rejects.toEqual(refusal("source.url-redirects"))
    expect(requests).toHaveLength(6)
  })

  it("a body larger than the limit, by its declared length and as it streams", async () => {
    const declared = site(() => answer(200, { "content-type": "text/plain", "content-length": "11" }, "x"))
    await expect(fetchPage("https://example.com/", { ...declared.options, limits: { maxBytes: 10 } })).rejects.toEqual(
      refusal("source.too-large"),
    )
    const streamed = site(() => answer(200, { "content-type": "text/plain" }, "123456", "789012"))
    await expect(fetchPage("https://example.com/", { ...streamed.options, limits: { maxBytes: 10 } })).rejects.toEqual(
      refusal("source.too-large"),
    )
  })

  it("a page that does not arrive within the time limit", async () => {
    vi.useFakeTimers()
    const { options } = site(() => new Promise<never>(() => {}))
    const read = fetchPage("https://slow.example/", options)
    const settled = expect(read).rejects.toEqual(refusal("source.url-timeout"))
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
  })

  it("an error status, naming it and the host only", async () => {
    const { options } = site(() => answer(404))
    const read = fetchPage("https://example.com/private?token=s3cret", options)
    await expect(read).rejects.toEqual(refusal("source.url-status", { status: 404 }))
    await expect(read).rejects.not.toThrow(/s3cret/)
  })

  it("a private Google document, by its sign-in redirect or its 401/403, naming Drive", async () => {
    const redirect = site(() => answer(302, { location: "https://accounts.google.com/ServiceLogin?continue=x" }))
    const doc = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit"
    await expect(fetchPage(doc, redirect.options)).rejects.toEqual(refusal("source.needs-sign-in"))
    expect(redirect.requests).toHaveLength(1)
    const forbidden = site(() => answer(403))
    await expect(
      fetchPage("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", forbidden.options),
    ).rejects.toThrow(/drive documents add <url> --profiles <names\|all>/)
    const elsewhere = site(() => answer(403))
    await expect(fetchPage("https://example.com/", elsewhere.options)).rejects.toEqual(
      refusal("source.url-status", { status: 403 }),
    )
  })

  it("a private Google document that answers 200 with its sign-in page", async () => {
    const page = readFileSync(new URL("./fixtures/google-sign-in.html", import.meta.url))
    const { options } = site(() => answer(200, { "content-type": "text/html; charset=utf-8" }, page))
    await expect(fetchPage("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit", options)).rejects.toEqual(
      refusal("source.needs-sign-in"),
    )
    const elsewhere = site(() => answer(200, { "content-type": "text/html; charset=utf-8" }, page))
    await expect(fetchPage("https://example.com/how-to-sign-in", elsewhere.options)).resolves.toMatchObject({
      read: "extracted",
    })
  })

  it("a redirect from https down to plain http", async () => {
    const { requests, options } = site(() => answer(302, { location: "http://example.com/plain" }))
    await expect(fetchPage("https://example.com/", options)).rejects.toEqual(
      refusal("source.url-refused", { kind: "downgrade" }),
    )
    expect(requests).toHaveLength(1)
  })

  it("a reader still busy when the time limit ends", async () => {
    vi.useFakeTimers()
    let aborted: AbortSignal | undefined
    onTestFinished(
      registerReader(
        {
          id: "slow-test",
          version: "v1",
          accepts: (hint) => hint.mime === "application/x-slow",
          read: (_bytes, _hint, context) => {
            aborted = context.signal
            return new Promise(() => {})
          },
        },
        { before: "office" },
      ),
    )
    const { options } = site(() => answer(200, { "content-type": "application/x-slow" }, "x"))
    const read = fetchPage("https://example.com/slow", options)
    const settled = expect(read).rejects.toEqual(refusal("source.url-timeout"))
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
    expect(aborted?.aborted).toBe(true)
  })

  it("a kind of page no reader takes", async () => {
    const { options } = site(() =>
      answer(200, { "content-type": "application/octet-stream" }, new Uint8Array([0, 1, 2])),
    )
    await expect(fetchPage("https://example.com/blob", options)).rejects.toEqual(refusal("source.unsupported"))
  })
})

describe("fetchPage reads", () => {
  it("follows redirects by hand, sends no cookie or credential, and names the tool", async () => {
    const { requests, options } = site(({ url }) =>
      url.pathname === "/start"
        ? answer(302, { location: "https://www.example.com/page", "set-cookie": "session=abc" })
        : answer(200, { "content-type": "text/plain; charset=utf-8" }, "Plain words about the relay"),
    )
    const page = await fetchPage("https://example.com/start", options)
    expect(page).toMatchObject({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://www.example.com/page",
      status: 200,
      contentType: "text/plain; charset=utf-8",
      bytes: 27,
      text: "Plain words about the relay",
      read: "extracted",
      truncated: false,
    })
    expect(page.extractor).toMatch(/^plain/)
    expect(requests).toHaveLength(2)
    for (const { headers, address } of requests) {
      expect(address).toEqual(PUBLIC)
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("cookie")
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization")
      expect(headers["user-agent"]).toBe(PAGE_USER_AGENT)
    }
  })

  it("takes a page whose name has a broken escape", async () => {
    const page = await fetchPage(
      "https://example.com/notes%E0%A4%A.txt",
      site(() => answer(200, { "content-type": "text/plain" }, "Plain words")).options,
    )
    expect(page).toMatchObject({ read: "extracted", text: "Plain words" })
  })

  it("picks the reader by content type: HTML, and an image kept without text", async () => {
    const page = await fetchPage(
      "https://example.com/post",
      site(() =>
        html(
          "<html><head><title>Relay</title></head><body><article><p>The relay starts at nine.</p></article></body></html>",
        ),
      ).options,
    )
    expect(page).toMatchObject({ read: "extracted", text: expect.stringContaining("The relay starts at nine.") })
    expect(page.extractor).toMatch(/^html/)
    const image = await fetchPage(
      "https://example.com/photo",
      site(() => answer(200, { "content-type": "image/png" }, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).options,
    )
    expect(image).toMatchObject({ read: "no-text", text: "", contentType: "image/png" })
  })
})

describe("nodeTransport", () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  })

  it("connects to the pinned address while asking for the page's own name", async () => {
    // The guard refuses by name before any lookup; `.invalid` never resolves, so only the pinned 127.0.0.1 answers.
    onTestFinished(allowNetwork())
    const seen: IncomingHttpHeaders[] = []
    const server = createServer((request, response) => {
      seen.push(request.headers)
      response.writeHead(200, { "content-type": "text/plain" }).end("pinned")
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const { port } = server.address() as AddressInfo
    const response = await nodeTransport({
      url: new URL(`http://page.invalid:${port}/notes`),
      address: { address: "127.0.0.1", family: 4 },
      headers: { "user-agent": PAGE_USER_AGENT },
      signal: new AbortController().signal,
    })
    const chunks: Uint8Array[] = []
    for await (const chunk of response.body) chunks.push(chunk)
    expect(response.status).toBe(200)
    expect(Buffer.concat(chunks).toString()).toBe("pinned")
    expect(seen).toEqual([expect.objectContaining({ host: `page.invalid:${port}`, "user-agent": PAGE_USER_AGENT })])
    expect(seen[0]).not.toHaveProperty("cookie")
  })
})
