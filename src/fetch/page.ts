import { lookup as dnsLookup } from "node:dns/promises"
import type { IncomingMessage } from "node:http"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { LookupFunction } from "node:net"
import { isIP } from "node:net"
import { CliError, isCliError } from "@wirecat/cli-base"
import { importEngine } from "../attachments/extract.js"
import { MAX_FILE_BYTES } from "../attachments/limits.js"
import { isGoogleDocumentHost } from "../domain/google-documents.js"
import { timeLimit } from "../http/time-limit.js"
import { readWithRegistry } from "../readers/registry.js"
import type { LoadEngine, Section } from "../readers/types.js"
import { isPublicAddress } from "./addresses.js"

export interface PageLimits {
  /** Bytes of the body as sent: the request asks for no compression, so this is what is read. */
  maxBytes: number
  /** For the whole read: every redirect and the body. */
  timeoutMs: number
  redirects: number
}

export const PAGE_LIMITS: PageLimits = { maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000, redirects: 5 }

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export type PageLookup = (hostname: string) => Promise<ResolvedAddress[]>

export interface PageRequest {
  url: URL
  /** The checked address the connection must go to, whatever the name resolves to by then. */
  address: ResolvedAddress
  headers: Readonly<Record<string, string>>
  signal: AbortSignal
}

export interface PageResponse {
  status: number
  header(name: string): string | null
  body: AsyncIterable<Uint8Array>
  /** Drops the rest of the body and the connection. */
  cancel(): void
}

/** Sends one GET to the pinned address and answers once the headers arrive; follows no redirect. */
export type PageTransport = (request: PageRequest) => Promise<PageResponse>

export interface FetchPageOptions {
  limits?: Partial<PageLimits>
  signal?: AbortSignal
  lookup?: PageLookup
  transport?: PageTransport
  load?: LoadEngine
}

export interface FetchedPage {
  /** The address as given: what a caller keeps as the source's address. */
  requestedUrl: string
  /** Where the redirects ended; it may carry a token a redirect signed, so it is never stored or logged. */
  finalUrl: string
  status: number
  contentType: string | null
  bytes: number
  /** Empty when `read` is `no-text`: an image, whose words a reader of the owner's choice may read later. */
  text: string
  extractor: string | null
  read: "extracted" | "no-text"
  /** The reader kept only the first part of the text. */
  truncated: boolean
  metadata?: Record<string, string | string[]>
  sections?: Section[]
}

/** Names the tool, never the owner. */
export const PAGE_USER_AGENT = "Mozilla/5.0 (compatible; WireCat)"

const HEADERS = {
  "user-agent": PAGE_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.9,*/*;q=0.5",
  "accept-encoding": "identity",
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

const refused = (message: string) => new CliError("validation_error", message, { reason: "source.url-refused" })

/** The address checked for its scheme and login: what every hop is checked by. */
const pageUrl = (address: string, base?: URL): URL => {
  let url: URL
  try {
    url = new URL(address, base)
  } catch {
    throw refused("the link is not an address")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw refused(`only http and https pages are read, not ${url.protocol.replace(/:$/, "")}`)
  if (url.username || url.password) throw refused("a link with a user name or password in it is not read")
  return url
}

const systemLookup: PageLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }))

/** Every address the name has must be public: the first is the one connected to. */
const checkedAddress = async (url: URL, lookup: PageLookup): Promise<ResolvedAddress> => {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
  const family = isIP(host)
  let found: ResolvedAddress[]
  try {
    found = family ? [{ address: host, family: family === 6 ? 6 : 4 }] : await lookup(host)
  } catch {
    throw new CliError("network_error", `${url.hostname} could not be found`, {
      reason: "source.url-unreachable",
      retryable: true,
    })
  }
  const [first] = found
  if (!first || found.some(({ address }) => !isPublicAddress(address)))
    throw refused(`${url.hostname} is not on the public internet, so it is not read`)
  return first
}

const pinnedTo =
  ({ address, family }: ResolvedAddress): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }

const headerOf = (message: IncomingMessage) => (name: string) => {
  const value = message.headers[name.toLowerCase()]
  return Array.isArray(value) ? value.join(", ") : (value ?? null)
}

/** node's own client, so the connection goes to the checked address and the TLS name stays the page's. */
export const nodeTransport: PageTransport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest
    const request = send(url, { method: "GET", headers, signal, agent: false, lookup: pinnedTo(address) }, (message) =>
      resolve({
        status: message.statusCode ?? 0,
        header: headerOf(message),
        body: message,
        cancel: () => message.destroy(),
      }),
    )
    request.on("error", reject)
    request.end()
  })

const tooLarge = (limit: number) =>
  new CliError("validation_error", `the page is larger than ${Math.round(limit / 1024 / 1024)} MiB`, {
    reason: "source.too-large",
  })

const readBody = async (response: PageResponse, limit: number): Promise<Uint8Array> => {
  const declared = Number(response.header("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    response.cancel()
    throw tooLarge(limit)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) {
      response.cancel()
      throw tooLarge(limit)
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

const needsSignIn = (url: URL) =>
  new CliError(
    "authentication_error",
    `${url.hostname} asks for a sign-in: read a private Google document through Drive`,
    {
      reason: "source.needs-sign-in",
    },
  )

/**
 * Google's sign-in page, as a private document may answer with 200: a form that posts to accounts.google.com's sign-in.
 * Only both markers together count, so a page that merely links to a sign-in is read.
 */
const isSignInPage = (bytes: Uint8Array, contentType: string | null) => {
  if (!contentType?.toLowerCase().includes("html")) return false
  const head = new TextDecoder().decode(bytes.subarray(0, 256 * 1024))
  return /<form[^>]+action="https:\/\/accounts\.google\.com\/[^"]*/i.test(head) && /ServiceLogin|\/signin\//.test(head)
}

const nameOf = (url: URL): string | null => {
  const raw = url.pathname.split("/").pop() ?? ""
  let last = raw
  try {
    last = decodeURIComponent(raw)
  } catch {}
  return last || null
}

const readPage = async (
  bytes: Uint8Array,
  url: URL,
  contentType: string | null,
  load: LoadEngine,
  signal: AbortSignal,
) => {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() || null
  const found = await readWithRegistry(
    bytes,
    { kind: "file", name: nameOf(url), mime, path: url.pathname },
    { load, signal },
  )
  switch (found.status) {
    case "extracted":
      if (!found.text.trim())
        throw new CliError("validation_error", "the page holds no text to keep", { reason: "source.no-text" })
      return {
        text: found.text,
        extractor: found.extractor,
        read: "extracted" as const,
        truncated: found.truncated ?? false,
        ...(found.metadata ? { metadata: found.metadata } : {}),
        ...(found.sections ? { sections: found.sections } : {}),
      }
    case "needs-agent":
      return { text: "", extractor: found.extractor ?? null, read: "no-text" as const, truncated: false }
    case "unsupported":
      throw new CliError("validation_error", `no reader takes ${mime ?? "this kind of page"}`, {
        reason: "source.unsupported",
      })
    case "unreadable":
      throw new CliError("validation_error", `the ${found.extractor} reader could not read the page`, {
        reason: "source.unreadable",
      })
    case "engine-missing":
      throw new CliError("configuration_error", `reading this page needs ${found.engine}, which is not installed`, {
        reason: "source.engine-missing",
      })
    case "too-large":
      throw new CliError("validation_error", "the page is larger than its reader reads", { reason: "source.too-large" })
  }
}

/**
 * One page read from the internet, for a source the owner adds by hand: http(s) only, every hop's address checked to
 * be public and connected to as checked, at most `redirects` redirects followed by hand, no cookies, no credentials,
 * and the reader chosen by the content type. Errors name the host only: an address may carry a token.
 */
export const fetchPage = async (address: string, options: FetchPageOptions = {}): Promise<FetchedPage> => {
  const limits = { ...PAGE_LIMITS, ...options.limits }
  const { lookup = systemLookup, transport = nodeTransport, load = importEngine } = options
  const deadline = timeLimit(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  const timedOut = () =>
    new CliError("timeout", `the page did not arrive within ${Math.round(limits.timeoutMs / 1000)} s`, {
      reason: "source.url-timeout",
      retryable: true,
    })
  const cancelled = new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
  })
  cancelled.catch(() => {})
  let url = pageUrl(address)
  const requested = url.href
  const google = isGoogleDocumentHost(url.hostname)
  try {
    for (let hop = 0; ; hop++) {
      const pinned = await Promise.race([checkedAddress(url, lookup), cancelled])
      const response = await Promise.race([transport({ url, address: pinned, headers: HEADERS, signal }), cancelled])
      const location = response.header("location")
      if (REDIRECTS.has(response.status) && location) {
        response.cancel()
        const next = pageUrl(location, url)
        if (google && next.hostname === "accounts.google.com") throw needsSignIn(url)
        if (url.protocol === "https:" && next.protocol === "http:")
          throw new CliError("validation_error", `${url.hostname} sent the request on from https to plain http`, {
            reason: "source.url-refused",
            kind: "downgrade",
          })
        if (hop >= limits.redirects)
          throw new CliError(
            "provider_error",
            `${url.hostname} sent the request on more than ${limits.redirects} times`,
            {
              reason: "source.url-redirects",
            },
          )
        url = next
        continue
      }
      if (google && (response.status === 401 || response.status === 403)) {
        response.cancel()
        throw needsSignIn(url)
      }
      if (response.status < 200 || response.status > 299) {
        response.cancel()
        throw new CliError("provider_error", `${url.hostname} answered HTTP ${response.status}`, {
          reason: "source.url-status",
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        })
      }
      const contentType = response.header("content-type")
      const bytes = await Promise.race([readBody(response, limits.maxBytes), cancelled])
      if (google && isSignInPage(bytes, contentType)) throw needsSignIn(url)
      const page = await Promise.race([readPage(bytes, url, contentType, load, signal), cancelled])
      return {
        requestedUrl: requested,
        finalUrl: url.href,
        status: response.status,
        contentType,
        bytes: bytes.byteLength,
        ...page,
      }
    }
  } catch (error) {
    if (deadline.signal.aborted && !(isCliError(error) && error.code !== "cancelled")) throw timedOut()
    if (isCliError(error)) throw error
    if (options.signal?.aborted) throw new CliError("cancelled", "reading the page was cancelled")
    // The cause's code only: a fetch error's message may quote the address.
    const cause =
      (error as { code?: unknown; cause?: { code?: unknown } }).code ??
      (error as { cause?: { code?: unknown } }).cause?.code
    throw new CliError(
      "network_error",
      `${url.hostname} could not be reached${typeof cause === "string" ? ` (${cause})` : ""}`,
      {
        reason: "source.url-unreachable",
        retryable: true,
      },
    )
  } finally {
    deadline.clear()
  }
}
