import { CliError } from "@wirecat/cli-base"
import { type FetchLike, type HostFetchOptions, hostFetch } from "@wirecat/cli-base/http"

const CREDENTIALS = ["authorization", "cookie", "proxy-authorization"]

/**
 * `fetch` for a URL the service handed back: a download or upload link, a signed file URL. Such a link lives on
 * another host (Yandex Disk's `downloader.disk.yandex.ru`, Notion's file store) and carries its own grant, so it goes
 * only to the hosts listed, over https, and never with the sign-in: a request carrying one is refused before it leaves.
 * `signIn` names a service's own sign-in headers (an API key's `X-Api-Key`) to refuse beside the standard ones.
 */
export const linkFetch = (options: HostFetchOptions & { signIn?: readonly string[] }): FetchLike => {
  const { signIn = [], ...rest } = options
  const send = hostFetch(rest)
  const refused = [...CREDENTIALS, ...signIn.map((name) => name.toLowerCase())]
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== "https:")
      throw new CliError("validation_error", `a link the service returned must be https, not ${url.protocol}`, {
        sent: false,
      })
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const carried = refused.filter((name) => headers.has(name))
    if (carried.length > 0)
      throw new CliError("configuration_error", `a link the service returned is never sent ${carried.join(" or ")}`, {
        sent: false,
      })
    return send(input, init)
  }
}
