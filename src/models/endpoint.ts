import { CliError, isCliError } from "@wirecat/cli-base"
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
 * `hostFetch`'s rules for an IPv6 literal, which it does not take as a host: only this host, a deadline, and no
 * redirect followed, since a model API has none to give.
 */
const literalFetch =
  (hostname: string, timeoutMs: number): FetchLike =>
  async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== hostname)
      throw new CliError("configuration_error", `${url.hostname} is not the model address's host, ${hostname}`, {
        reason: "network.host-undeclared",
        sent: false,
      })
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    try {
      const response = await fetch(input, { ...init, signal, redirect: "manual" })
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {})
        throw new CliError("invalid_response", `${hostname} answered with a redirect, which is not followed`)
      }
      return response
    } catch (error) {
      if (isCliError(error)) throw error
      if (init.signal?.aborted) throw new CliError("cancelled", "request cancelled")
      if (deadline.aborted)
        throw new CliError("timeout", `${hostname} did not answer within ${timeoutMs} ms`, { retryable: true })
      throw new CliError("network_error", `${hostname} could not be reached`, { retryable: true })
    }
  }

/**
 * `fetch` that reaches only the host of this model address, through `hostFetch`. The address was checked when it was
 * saved; its host is the one the person configured. `[::1]` cannot leave this computer, so it goes through the plain
 * `fetch`; any other IPv6 literal through `literalFetch`.
 */
export const endpointFetch = (address: string, timeoutMs: number): FetchLike => {
  const { hostname } = new URL(address)
  if (hostname === "[::1]") return fetch
  return hostname.startsWith("[") ? literalFetch(hostname, timeoutMs) : hostFetch({ hosts: [hostname], timeoutMs })
}
