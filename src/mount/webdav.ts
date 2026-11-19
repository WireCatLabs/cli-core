import { timingSafeEqual } from "node:crypto"
import { CliError, isCliError } from "@wirecat/cli-base"
import type { ByteRange, MountEntry, MountSource } from "./source.js"

/** WebDAV class 1 only: without class 2 (LOCK) a client has nothing to lock a file it would write with. */
const ALLOW = "OPTIONS, PROPFIND, GET, HEAD"
const MOST_CACHED = 2000

export interface WebdavOptions {
  /** The first path segment every request must carry; the URL the owner mounts holds it. */
  secret: string
  /** The `Host` values a request may carry, such as `127.0.0.1:8080`; any other is a page on another site. */
  hosts: () => readonly string[]
  /** How long a listing or a stat answers from memory. */
  cacheMs?: number
  now?: () => number
  /** A failure other than `not_found`, for the command to report; never the request, whose path holds the secret. */
  onError?: (error: unknown) => void
}

class BadPath extends Error {}

const sameSecret = (given: string, secret: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The path under the mount, decoded one segment at a time. A segment that decodes to a separator or a dot step is
 * refused: `a%2F..%2F..` survives URL parsing and would climb out of the mounted folder once the service joins it.
 */
const innerPath = (segments: readonly string[]) => {
  const names = segments
    .filter((segment) => segment !== "")
    .map((segment) => {
      let name: string
      try {
        name = decodeURIComponent(segment)
      } catch {
        throw new BadPath()
      }
      if (name === "." || name === ".." || /[/\\\0]/u.test(name)) throw new BadPath()
      return name
    })
  return `/${names.join("/")}`
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/"
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const childOf = (path: string, name: string) => (path === "/" ? `/${name}` : `${path}/${name}`)

const xml = (text: string) =>
  text.replace(/[<>&"']/gu, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c)

const etagOf = (entry: MountEntry) => {
  const tag = entry.version ?? (entry.modifiedAt ? `${entry.modifiedAt}-${entry.size ?? 0}` : undefined)
  return tag === undefined ? undefined : `"${tag.replace(/["\\]/gu, "")}"`
}

const httpDate = (iso: string | undefined) => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(ms) ? undefined : new Date(ms).toUTCString()
}

const hrefOf = (secret: string, path: string, folder: boolean) => {
  const encoded = path === "/" ? "" : path.split("/").map(encodeURIComponent).join("/")
  return `/${secret}${encoded}${folder ? "/" : ""}`
}

const responseXml = (href: string, entry: MountEntry) => {
  const props = [
    `<D:displayname>${xml(entry.name)}</D:displayname>`,
    entry.folder ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>",
    ...(entry.folder || entry.size === undefined ? [] : [`<D:getcontentlength>${entry.size}</D:getcontentlength>`]),
    ...(entry.folder ? [] : [`<D:getcontenttype>${xml(entry.mime ?? "application/octet-stream")}</D:getcontenttype>`]),
    ...[httpDate(entry.modifiedAt)].filter(Boolean).map((date) => `<D:getlastmodified>${date}</D:getlastmodified>`),
    ...(entry.createdAt ? [`<D:creationdate>${xml(entry.createdAt)}</D:creationdate>`] : []),
    ...[etagOf(entry)].filter(Boolean).map((tag) => `<D:getetag>${xml(tag ?? "")}</D:getetag>`),
  ]
  return (
    `<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>${props.join("")}</D:prop>` +
    "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
  )
}

const multistatus = (responses: string[]) =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`,
    {
      status: 207,
      headers: { "content-type": "application/xml; charset=utf-8" },
    },
  )

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } })

/** One `bytes=` range; anything else (several ranges, another unit) is ignored and the whole file is sent. */
const rangeOf = (header: string | null, size: number | undefined): ByteRange | "unsatisfiable" | undefined => {
  if (header === null || size === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match) return undefined
  const [, from = "", to = ""] = match
  if (from === "" && to === "") return undefined
  if (from === "") {
    const suffix = Number(to)
    if (suffix === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  if (start >= size) return "unsatisfiable"
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1)
  return end < start ? undefined : { start, end }
}

interface Cached<T> {
  at: number
  value: Promise<T>
}

/**
 * Listings and stats answer from memory for `ms`, and a stat is answered from its parent's listing when that is
 * fresh: a file manager asks for `.DS_Store`, `desktop.ini` and thumbnails in every folder, and each would otherwise be
 * a request that counts against the service's rate limit.
 */
const cachedSource = (source: MountSource, ms: number, now: () => number) => {
  const lists = new Map<string, Cached<MountEntry[]>>()
  const stats = new Map<string, Cached<MountEntry>>()
  const fresh = <T>(map: Map<string, Cached<T>>, key: string) => {
    const hit = map.get(key)
    if (hit && now() - hit.at < ms) return hit.value
    map.delete(key)
    return undefined
  }
  const keep = <T>(map: Map<string, Cached<T>>, key: string, value: Promise<T>) => {
    if (map.size >= MOST_CACHED) map.delete(map.keys().next().value as string)
    map.set(key, { at: now(), value })
    value.catch(() => map.delete(key))
    return value
  }
  const list = (path: string) =>
    fresh(lists, path) ??
    keep(
      lists,
      path,
      source.list(path).then((entries) => {
        for (const entry of entries) keep(stats, childOf(path, entry.name), Promise.resolve(entry))
        return entries
      }),
    )
  const stat = async (path: string): Promise<MountEntry> => {
    const hit = fresh(stats, path)
    if (hit) return hit
    const siblings = path === "/" ? undefined : fresh(lists, parentOf(path))
    if (siblings) {
      const found = (await siblings).find((entry) => entry.name === baseOf(path))
      if (found) return found
      throw notFound()
    }
    return keep(stats, path, source.stat(path))
  }
  return { list, stat }
}

const notFound = () => new CliError("not_found", "no such item")
const isNotFound = (error: unknown) => isCliError(error) && error.code === "not_found"

const failure = (error: unknown, onError?: (error: unknown) => void) => {
  if (isNotFound(error)) return plain(404, "not found")
  onError?.(error)
  if (isCliError(error) && error.code === "rate_limited") {
    const wait = Number(error.details?.retry_after_ms ?? 60_000)
    return plain(503, "the service asked to slow down", { "retry-after": String(Math.ceil(wait / 1000)) })
  }
  return plain(502, "the service did not answer")
}

/**
 * A read-only WebDAV server over a `MountSource`, as a web-standard handler. Every request must name an allowed
 * `Host` (a page on another site that rebinds its name to 127.0.0.1 cannot), carry no foreign `Origin`, and start
 * with the secret; it may only read. Answers carry no CORS header, so no page can read them.
 */
export const webdavHandler = (source: MountSource, options: WebdavOptions) => {
  const { secret, onError } = options
  const cache = cachedSource(source, options.cacheMs ?? 10_000, options.now ?? Date.now)

  const propfind = async (request: Request, path: string) => {
    const depth = request.headers.get("depth")?.trim().toLowerCase() ?? "1"
    if (depth !== "0" && depth !== "1")
      return new Response(
        '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
        { status: 403, headers: { "content-type": "application/xml; charset=utf-8" } },
      )
    const entry = await cache.stat(path)
    const own = responseXml(hrefOf(secret, path, entry.folder), entry)
    if (depth === "0" || !entry.folder) return multistatus([own])
    const children = await cache.list(path)
    return multistatus([
      own,
      ...children.map((child) => responseXml(hrefOf(secret, childOf(path, child.name), child.folder), child)),
    ])
  }

  const get = async (request: Request, path: string) => {
    const entry = await cache.stat(path)
    if (entry.folder) {
      const names = (await cache.list(path)).map((child) => `${child.name}${child.folder ? "/" : ""}`)
      return plain(200, request.method === "HEAD" ? "" : `${names.join("\n")}\n`)
    }
    const etag = etagOf(entry)
    const lastModified = httpDate(entry.modifiedAt)
    const headers: Record<string, string> = {
      "content-type": entry.mime ?? "application/octet-stream",
      "accept-ranges": "bytes",
      ...(etag ? { etag } : {}),
      ...(lastModified ? { "last-modified": lastModified } : {}),
    }
    const ifRange = request.headers.get("if-range")
    const asked = ifRange !== null && ifRange !== etag && ifRange !== lastModified ? null : request.headers.get("range")
    const range = rangeOf(asked, entry.size)
    if (range === "unsatisfiable")
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${entry.size}` } })
    const whole: Record<string, string> = entry.size === undefined ? {} : { "content-length": String(entry.size) }
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, ...whole } })
    const read = await source.read(path, entry, range)
    if (!range || !read.ranged) return new Response(read.body, { status: 200, headers: { ...headers, ...whole } })
    return new Response(read.body, {
      status: 206,
      headers: {
        ...headers,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${range.start}-${range.end}/${entry.size}`,
      },
    })
  }

  return async (request: Request): Promise<Response> => {
    if (!options.hosts().includes(request.headers.get("host") ?? "")) return plain(403, "this host is not served")
    const origin = request.headers.get("origin")
    if (origin !== null && !options.hosts().some((host) => origin === `http://${host}`))
      return plain(403, "this origin is not served")
    const segments = new URL(request.url).pathname.split("/").slice(1)
    if (request.method === "OPTIONS")
      return new Response(null, { status: 200, headers: { dav: "1", allow: ALLOW, "ms-author-via": "DAV" } })
    // Windows asks about the server's top before the folder it mounts; an empty folder answers it and shows nothing.
    if (request.method === "PROPFIND" && segments.every((segment) => segment === ""))
      return multistatus([responseXml("/", { name: "", folder: true })])
    if (!sameSecret(segments[0] ?? "", secret)) return plain(404, "not found")
    if (!["PROPFIND", "GET", "HEAD"].includes(request.method))
      return plain(405, "this mount is read-only", { allow: ALLOW })
    let path: string
    try {
      path = innerPath(segments.slice(1))
    } catch {
      return plain(400, "this path is refused")
    }
    try {
      return await (request.method === "PROPFIND" ? propfind(request, path) : get(request, path))
    } catch (error) {
      return failure(error, onError)
    }
  }
}
