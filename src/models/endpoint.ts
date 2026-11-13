import { type FetchLike, hostFetch } from "@wirecat/cli-base/http"

export const endpoint = (value: string): boolean => {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

const loopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname)

/** An address on this computer: localhost, 127.x.x.x or [::1]. */
export const onThisComputer = (value: string): boolean => {
  try {
    return loopback(new URL(value).hostname)
  } catch {
    return false
  }
}

/** https anywhere; plain http only to this computer, so neither the text nor the key crosses a network unencrypted. */
export const modelAddressAllowed = (value: string): boolean =>
  endpoint(value) && (new URL(value).protocol === "https:" || onThisComputer(value))

export const PLAIN_HTTP_REFUSED = "this address is not allowed: use https, or http only on this computer"

/**
 * `fetch` that reaches only the host of this model address, through `hostFetch`. The address was checked when it was
 * saved; its host is the one the person configured. `[::1]` is not a name `hostFetch` takes, and the loopback cannot
 * leave this computer, so it goes through the plain `fetch`.
 */
export const endpointFetch = (address: string, timeoutMs: number): FetchLike => {
  const { hostname } = new URL(address)
  return hostname === "[::1]" ? fetch : hostFetch({ hosts: [hostname], timeoutMs })
}
