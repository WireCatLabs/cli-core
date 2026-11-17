import { CliError } from "@wirecat/cli-base"
import type { FetchLike } from "@wirecat/cli-base/http"

/**
 * The API root a site names in its `Link` header, as WordPress does with `rel="https://api.w.org/"`: `…/wp-json/`, or
 * `…/?rest_route=/` without pretty permalinks. `undefined` when the site names none; another origin is refused, since
 * the token would follow it.
 */
export const linkedApiRoot = async (site: string, fetch: FetchLike, rel: string): Promise<string | undefined> => {
  const home = new URL(`https://${site}/`)
  const response = await fetch(home.href, { method: "HEAD" })
  void response.body?.cancel().catch(() => {})
  const root = linksOf(response.headers.get("link") ?? "").find((link) => link.rels.includes(rel))?.url
  if (root === undefined) return undefined
  const url = new URL(root, home)
  if (url.origin !== home.origin)
    throw new CliError("invalid_response", `${site} names its API on another host, ${url.host}; nothing was sent there`)
  return url.href
}

const linksOf = (header: string) =>
  [...header.matchAll(/<([^>]*)>([^,<]*)/g)].map(([, url = "", params = ""]) => ({
    url,
    rels: (/;\s*rel="?([^";]+)"?/i.exec(params)?.[1] ?? "").split(/\s+/),
  }))
