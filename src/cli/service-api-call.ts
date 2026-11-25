import { CliError } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen/runtime"
import { type FetchLike, hostFetch } from "@wirecat/cli-base/http"
import { Command } from "commander"
import type { ApiCommandInput } from "./bot/api.js"
import { type HttpApiSendOptions, httpApiExchange, httpApiRequest } from "./bot/api-http.js"
import { manifestBaseUrl, type ServiceApiManifest, signRequest, underBase } from "./service-api-manifest.js"

/** One operation of the generated manifest, by its id, sent with the sign-in its security scheme names. */
export type ServiceApiCall = (operation: string, input: ApiCommandInput) => Promise<unknown>

/** The same read, with the response's headers, where a service pages (WordPress's `X-WP-TotalPages`, for `nextPage`). */
export type ServiceApiCallWithHeaders = (
  operation: string,
  input: ApiCommandInput,
) => Promise<{ body: unknown; headers: Headers }>

export interface ServiceApiCallOptions {
  manifest: ServiceApiManifest
  /** The service's name in messages: "HubSpot". */
  service: string
  /** The host-checked fetch with the CLI's pace and retry of reads, as the `api` group gets it. */
  fetch: FetchLike
  /** Left out, for a CLI without sign-in, no call carries one. */
  token?: () => string | Promise<string>
  /** In place of the manifest's first server. */
  baseUrl?: string
  /** The values of the server's free variables, such as `{ site }` from the profile's sign-in (`recalledSite`). */
  serverVariables?: Readonly<Record<string, string>>
  /** Headers beside the sign-in, such as the API version. */
  headers?: (operation: ManifestOperation) => Record<string, string>
  failure?: HttpApiSendOptions["failure"]
  failedAnswer?: HttpApiSendOptions["failedAnswer"]
}

/**
 * A fetch that reaches only `hosts` (WC-CMD-32), over the fetch a test gives in its environment, or the network when
 * none: a CLI passes `environment.fetch` as it is.
 */
export const hostsFetch = (
  hosts: readonly string[],
  fetch: FetchLike | undefined,
  /** Where the sign-in may go, for a site under a path (`https://host/blog/wp-json`): see cli-base `hostFetch`. */
  credentialScope?: string,
): FetchLike => hostFetch({ hosts, ...(fetch ? { fetch } : {}), ...(credentialScope ? { credentialScope } : {}) })

// The run record and the fetch are the only things httpApiSend asks a command for, and a sync has no command of its own.
const NO_COMMAND = new Command("source")

const sender = (options: ServiceApiCallOptions, writes: boolean): ServiceApiCallWithHeaders => {
  const baseUrl = manifestBaseUrl(options.manifest, options.baseUrl, options.serverVariables)
  const operations = new Map(options.manifest.operations.map((one) => [one.id, one]))
  const exchange = httpApiExchange({
    service: options.service,
    fetch: () => options.fetch,
    failure: options.failure,
    failedAnswer: options.failedAnswer,
  })
  return async (id, input) => {
    const operation = operations.get(id)
    if (!operation) throw new CliError("configuration_error", `no ${options.service} API operation ${id}`)
    if (!writes && operation.effect !== "read")
      throw new CliError("configuration_error", `${operation.command} is not a read; a source only reads`)
    const request = httpApiRequest(operation, input, baseUrl)
    if (!underBase(request.url, baseUrl))
      throw new CliError("validation_error", `${operation.command} would leave ${baseUrl}`, { sent: false })
    const extra = Object.entries(options.headers?.(operation) ?? {})
    for (const [name, value] of extra) request.headers.set(name, value)
    await signRequest(options.manifest, operation, request, options.token)
    // A redirect to another host drops only the standard sign-in headers; a hook's header would go along. A site
    // shares its host with others, and only its path tells them apart, so its sign-in follows no redirect.
    if (extra.length || options.serverVariables) request.redirect = "manual"
    const { answer, headers } = await exchange(NO_COMMAND, operation, request)
    return { body: answer, headers }
  }
}

/**
 * The `api` group's request path for code that is not a command, such as a source read from a manifest: the same
 * request building, sign-in header, redirect rule, run record and refusals as `serviceApiCommand`, without a guard. It
 * sends reads only; a write goes through `serviceApiWriter` or the `api` group, where the profile's guard asks. A
 * request is sent only under the server's address, path included: a site at `host/blog` never signs `host/other`.
 */
export const serviceApiCall = (
  options: ServiceApiCallOptions,
): ServiceApiCall & { withHeaders: ServiceApiCallWithHeaders } => {
  const withHeaders = sender(options, false)
  return Object.assign(async (id: string, input: ApiCommandInput) => (await withHeaders(id, input)).body, {
    withHeaders,
  })
}

/**
 * `serviceApiCall` that sends writes too, with no guard of its own: only for a writer that cli-core's CRM writes
 * wrap in theirs (`crm/writes.ts`), which checks the operation's `api` keys. Never exported from the package: a CLI
 * that sends a write itself goes through `serviceApiWriter`. A write is sent once; a lost answer is `outcome_unknown`.
 */
export const serviceApiSend = (options: ServiceApiCallOptions): ServiceApiCall => {
  const withHeaders = sender(options, true)
  return async (id, input) => (await withHeaders(id, input)).body
}
