import { CliError } from "@wirecat/cli-base"
import { type FetchLike, hostFetch } from "@wirecat/cli-base/http"

export interface CrmFileFetchOptions {
  /** The account's own hosts, such as the Bitrix24 portal or amoCRM's `drive_url` host: the only ones asked. */
  hosts: readonly string[]
  /** Sent only to those hosts, such as a Bearer token. */
  headers?: Record<string, string>
  signal?: AbortSignal
  fetch?: FetchLike
}

/** A large file on a slow line; the command's own deadline and `--timeout` stop it sooner. */
const EXCHANGE_MS = 60 * 60 * 1000

const MOST_REDIRECTS = 5

/**
 * A file's bytes behind a CRM link, for an adapter's `CrmOpenableFile.open`. https only, the account's own hosts only,
 * redirects followed only on them, so the credentials go nowhere else. An HTML page is a CRM's answer to a link that is
 * not a server link: refused. No error carries the link, which holds a token.
 */
export const fetchCrmFile = async (link: string, options: CrmFileFetchOptions): Promise<ReadableStream<Uint8Array>> => {
  const send = options.fetch ?? hostFetch({ hosts: options.hosts, timeoutMs: EXCHANGE_MS })
  const refused = (why: string) =>
    new CliError("provider_error", `the CRM's file link was refused: ${why}`, { reason: "crm.file-unavailable" })
  let at = link
  for (let hop = 0; hop <= MOST_REDIRECTS; hop += 1) {
    let url: URL
    try {
      url = new URL(at)
    } catch {
      throw refused("it is not a link")
    }
    if (url.protocol !== "https:") throw refused("it is not https")
    if (!options.hosts.includes(url.hostname.toLowerCase()))
      throw refused("it points to another host than the account's")
    let answer: Response
    try {
      answer = await send(url, {
        redirect: "manual",
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch {
      if (options.signal?.aborted) throw new CliError("cancelled", "the file download was stopped")
      throw new CliError("network_error", "the CRM's file server could not be reached", {
        reason: "crm.file-unavailable",
      })
    }
    const next = answer.headers.get("location")
    if (answer.status >= 300 && answer.status < 400 && next) {
      await answer.body?.cancel().catch(() => {})
      at = new URL(next, url).href
      continue
    }
    if (!answer.ok || !answer.body) {
      await answer.body?.cancel().catch(() => {})
      throw new CliError("provider_error", `the CRM's file server answered ${answer.status}`, {
        reason: "crm.file-unavailable",
      })
    }
    if ((answer.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
      await answer.body.cancel().catch(() => {})
      throw refused("the CRM answered a web page, not the file")
    }
    return answer.body
  }
  throw refused("too many redirects")
}
