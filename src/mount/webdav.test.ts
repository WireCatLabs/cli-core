import { request as httpRequest } from "node:http"
import { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import { type MountEntry, type Mounted, type MountSource, serveMount } from "./index.js"

const SECRET = "s3cret-for-tests"
const TEXT = "0123456789abcdefghij"

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

const send = (url: URL, method: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      {
        method,
        agent: false,
        // Node sends a DELETE body with no length unless told, and the server then reads it as a second request.
        headers: {
          host: url.host,
          ...(body === undefined ? {} : { "content-length": String(body.length) }),
          ...headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
        incoming.on("error", reject)
      },
    )
    outgoing.on("error", reject)
    outgoing.end(body)
  })

const tree: Record<string, MountEntry[]> = {
  "/": [
    { name: "Docs", folder: true, modifiedAt: "2026-01-02T03:04:05Z" },
    { name: "a & b.txt", folder: false, size: TEXT.length, mime: "text/plain", version: "md5abc" },
  ],
  "/Docs": [{ name: "plan.md", folder: false, size: 3, modifiedAt: "2026-01-02T03:04:05Z" }],
}

const fakeSource = (options: { ranges?: boolean; fail?: unknown } = {}) => {
  const calls: string[] = []
  const entryAt = (path: string): MountEntry => {
    if (path === "/") return { name: "Disk", folder: true }
    const parent = path.slice(0, path.lastIndexOf("/")) || "/"
    const found = tree[parent]?.find((entry) => `${parent === "/" ? "" : parent}/${entry.name}` === path)
    if (!found) throw new CliError("not_found", "missing")
    return found
  }
  const source: MountSource = {
    stat: async (path) => {
      calls.push(`stat ${path}`)
      if (options.fail) throw options.fail
      return entryAt(path)
    },
    list: async (path) => {
      calls.push(`list ${path}`)
      if (options.fail) throw options.fail
      const children = tree[path]
      if (!children) throw new CliError("not_found", "missing")
      return children
    },
    read: async (path, _entry, range) => {
      calls.push(`read ${path} ${range ? `${range.start}-${range.end}` : "all"}`)
      const ranged = options.ranges !== false && range !== undefined
      const text = ranged ? TEXT.slice(range.start, range.end + 1) : TEXT
      return { body: new Response(text).body as ReadableStream<Uint8Array>, ranged }
    },
  }
  return { source, calls }
}

let mounted: Mounted | undefined
afterEach(async () => {
  await mounted?.close()
  mounted = undefined
})

const start = async (options: Parameters<typeof fakeSource>[0] = {}, now = () => 0) => {
  const fake = fakeSource(options)
  const errors: unknown[] = []
  mounted = await serveMount(fake.source, { secret: SECRET, now, onError: (error) => errors.push(error) })
  return { ...fake, errors, url: (path = "") => new URL(`${mounted?.url}${path}`) }
}

describe("serveMount", () => {
  it("binds 127.0.0.1 and prints a URL that holds only the secret", async () => {
    const { url } = await start()
    expect(url().hostname).toBe("127.0.0.1")
    expect(url().pathname).toBe(`/${SECRET}/`)
    expect(mounted?.how.linux).toBe(`gio mount dav://127.0.0.1:${url().port}/${SECRET}/`)
  })

  it("answers OPTIONS as a class 1 server that only reads", async () => {
    const { url } = await start()
    const answer = await send(url(), "OPTIONS")
    expect(answer.status).toBe(200)
    expect(answer.headers.dav).toBe("1")
    expect(answer.headers.allow).toBe("OPTIONS, PROPFIND, GET, HEAD")
  })

  it("lists a folder at depth 1 with escaped names and the secret in each href", async () => {
    const { url } = await start()
    const answer = await send(url(), "PROPFIND", { depth: "1" })
    expect(answer.status).toBe(207)
    expect(answer.body).toContain(`<D:href>/${SECRET}/</D:href>`)
    expect(answer.body).toContain(`<D:href>/${SECRET}/Docs/</D:href>`)
    expect(answer.body).toContain(`<D:href>/${SECRET}/a%20%26%20b.txt</D:href>`)
    expect(answer.body).toContain("<D:displayname>a &amp; b.txt</D:displayname>")
    expect(answer.body).toContain("<D:getcontentlength>20</D:getcontentlength>")
    expect(answer.body).toContain("<D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</D:getlastmodified>")
    expect(answer.body).toContain("<D:getetag>&quot;md5abc&quot;</D:getetag>")
    expect(answer.body).toContain("<Z:Win32FileAttributes>00000001</Z:Win32FileAttributes>")
  })

  it("answers depth 0 with the item alone and refuses depth infinity", async () => {
    const { url } = await start()
    const one = await send(url("Docs/"), "PROPFIND", { depth: "0" })
    expect(one.status).toBe(207)
    expect(one.body.match(/<D:response>/gu)).toHaveLength(1)
    expect(one.body).toContain("<D:collection/>")
    const all = await send(url(), "PROPFIND", { depth: "infinity" })
    expect(all.status).toBe(403)
    expect(all.body).toContain("propfind-finite-depth")
  })

  it("answers a stat from the parent's fresh listing and asks again once the cache is stale", async () => {
    let clock = 0
    const { url, calls } = await start({}, () => clock)
    await send(url(), "PROPFIND", { depth: "1" })
    await send(url("Docs/"), "PROPFIND", { depth: "0" })
    expect((await send(url(".DS_Store"), "PROPFIND", { depth: "0" })).status).toBe(404)
    expect(calls).toEqual(["stat /", "list /"])
    clock = 60_000
    await send(url("Docs/"), "PROPFIND", { depth: "0" })
    expect(calls).toEqual(["stat /", "list /", "stat /Docs"])
  })

  it("streams a whole file with its length, type and validators", async () => {
    const { url } = await start()
    const answer = await send(url("a%20%26%20b.txt"), "GET")
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(TEXT)
    expect(answer.headers["content-length"]).toBe("20")
    expect(answer.headers["content-type"]).toBe("text/plain")
    expect(answer.headers["accept-ranges"]).toBe("bytes")
    expect(answer.headers.etag).toBe('"md5abc"')
  })

  it("serves a file sandboxed, so an HTML file on the mount cannot script the mount's own origin", async () => {
    const { url } = await start()
    for (const method of ["GET", "HEAD"]) {
      const answer = await send(url("a%20%26%20b.txt"), method)
      expect(answer.headers["content-security-policy"]).toBe("sandbox")
      expect(answer.headers["x-content-type-options"]).toBe("nosniff")
    }
  })

  it("answers a range with 206 and reads only that range", async () => {
    const { url, calls } = await start()
    const answer = await send(url("a%20%26%20b.txt"), "GET", { range: "bytes=5-9" })
    expect(answer.status).toBe(206)
    expect(answer.body).toBe("56789")
    expect(answer.headers["content-range"]).toBe("bytes 5-9/20")
    expect(answer.headers["content-length"]).toBe("5")
    expect(calls).toContain("read /a & b.txt 5-9")
    const tail = await send(url("a%20%26%20b.txt"), "GET", { range: "bytes=-3" })
    expect(tail.body).toBe("hij")
  })

  it("sends the whole file with 200 when the service ignores the range", async () => {
    const { url } = await start({ ranges: false })
    const answer = await send(url("a%20%26%20b.txt"), "GET", { range: "bytes=5-9" })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(TEXT)
  })

  it("refuses a range past the end and ignores one under a stale If-Range", async () => {
    const { url } = await start()
    const past = await send(url("a%20%26%20b.txt"), "GET", { range: "bytes=50-" })
    expect(past.status).toBe(416)
    expect(past.headers["content-range"]).toBe("bytes */20")
    const stale = await send(url("a%20%26%20b.txt"), "GET", { range: "bytes=0-1", "if-range": '"old"' })
    expect(stale.status).toBe(200)
  })

  it("answers HEAD without reading the file", async () => {
    const { url, calls } = await start()
    const answer = await send(url("a%20%26%20b.txt"), "HEAD")
    expect(answer.status).toBe(200)
    expect(answer.headers["content-length"]).toBe("20")
    expect(calls.some((call) => call.startsWith("read"))).toBe(false)
  })

  it.each([
    ["PUT", 405],
    ["DELETE", 405],
    ["MOVE", 405],
    ["COPY", 405],
    ["MKCOL", 403],
    ["PROPPATCH", 405],
    ["LOCK", 405],
    ["UNLOCK", 405],
    ["POST", 405],
  ])("refuses %s with %i and asks the source nothing", async (method, status) => {
    const { url, calls } = await start()
    const answer = await send(url("a%20%26%20b.txt"), method, {}, "x")
    expect(answer.status).toBe(status)
    expect(answer.headers.allow).toBe("OPTIONS, PROPFIND, GET, HEAD")
    expect(calls).toEqual([])
  })

  it("refuses a body too large to be a PROPFIND before reading it", async () => {
    const { url, calls } = await start()
    const answer = await send(url("big.bin"), "PUT", {}, "x".repeat(100 * 1024))
    expect(answer.status).toBe(413)
    expect(calls).toEqual([])
  })

  it("answers a wrong or missing secret with 404", async () => {
    const { url, calls } = await start()
    const base = url()
    for (const path of ["/wrong/", `/${SECRET}x/`, `/${SECRET.slice(0, -1)}/a%20%26%20b.txt`]) {
      const answer = await send(new URL(path, base), "GET")
      expect(answer.status).toBe(404)
    }
    expect(calls).toEqual([])
  })

  it("answers PROPFIND at the server's top with an empty folder that names nothing", async () => {
    const { url, calls } = await start()
    const answer = await send(new URL("/", url()), "PROPFIND", { depth: "1" })
    expect(answer.status).toBe(207)
    expect(answer.body).not.toContain(SECRET)
    expect(calls).toEqual([])
  })

  it("refuses another Host, as a page that rebinds its name to 127.0.0.1 sends", async () => {
    const { url, calls } = await start()
    const answer = await send(url(), "PROPFIND", { host: `evil.example:${url().port}`, depth: "1" })
    expect(answer.status).toBe(403)
    const port = await send(url(), "GET", { host: "127.0.0.1:1" })
    expect(port.status).toBe(403)
    expect(calls).toEqual([])
  })

  it("accepts localhost and refuses a foreign Origin, with no CORS header", async () => {
    const { url } = await start()
    const local = await send(url("a%20%26%20b.txt"), "GET", { host: `localhost:${url().port}` })
    expect(local.status).toBe(200)
    const foreign = await send(url("a%20%26%20b.txt"), "GET", { origin: "https://evil.example" })
    expect(foreign.status).toBe(403)
    expect(local.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it.each(["a%2F..%2F..%2Fsecret", "..%2F..", "a%5Cb", "a%00b", "%E0%A4%A"])(
    "refuses the path segment %s, which would leave the mounted folder once joined",
    async (path) => {
      const { url, calls } = await start()
      expect((await send(url(path), "GET")).status).toBe(400)
      expect(calls).toEqual([])
    },
  )

  it("never reaches the source with a dot step, which URL parsing folds into the secret's place", async () => {
    const { url, calls } = await start()
    expect((await send(url("%2E%2E/x"), "GET")).status).toBe(404)
    expect(calls).toEqual([])
  })

  it("answers 503 with Retry-After when the service asks to slow down, and keeps serving", async () => {
    const { url, errors } = await start({
      fail: new CliError("rate_limited", "slow down", { retry_after_ms: 30_000 }),
    })
    const answer = await send(url(), "PROPFIND", { depth: "0" })
    expect(answer.status).toBe(503)
    expect(answer.headers["retry-after"]).toBe("30")
    expect(errors).toHaveLength(1)
    expect((await send(url(), "OPTIONS")).status).toBe(200)
  })

  it("answers 502 when the service fails another way", async () => {
    const { url } = await start({ fail: new CliError("network_error", "down") })
    expect((await send(url(), "PROPFIND", { depth: "0" })).status).toBe(502)
  })
})
