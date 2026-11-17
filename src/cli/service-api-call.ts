import { CliError } from "@wirecat/cli-base"
import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import type { FetchLike } from "@wirecat/cli-base/http"
import { Command } from "commander"
import type { ApiCommandInput } from "./bot/api.js"
import { type HttpApiSendOptions, httpApiRequest, httpApiSend } from "./bot/api-http.js"
import { manifestBaseUrl, type ServiceApiManifest, signRequest } from "./service-api-manifest.js"

/** One operation of the generated manifest, by its id, sent with the sign-in its security scheme names. */
export type ServiceApiCall = (operation: string, input: ApiCommandInput) => Promise<unknown>

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
}

// The run record and the fetch are the only things httpApiSend asks a command for, and a sync has no command of its own.
const NO_COMMAND = new Command("source")

/**
 * The `api` group's request path for code that is not a command, such as a source read from a manifest: the same
 * request building, sign-in header, redirect rule, run record and refusals as `serviceApiCommand`, without a guard. It
 * sends reads only; a write goes through the `api` group, where the profile's guard asks.
 */
export const serviceApiCall = (options: ServiceApiCallOptions): ServiceApiCall => {
  const baseUrl = manifestBaseUrl(options.manifest, options.baseUrl, options.serverVariables)
  const operations = new Map(options.manifest.operations.map((one) => [one.id, one]))
  const send = httpApiSend({ service: options.service, fetch: () => options.fetch, failure: options.failure })
  return async (id, input) => {
    const operation = operations.get(id)
    if (!operation) throw new CliError("configuration_error", `no ${options.service} API operation ${id}`)
    if (operation.effect !== "read")
      throw new CliError("configuration_error", `${operation.command} is not a read; a source only reads`)
    const request = httpApiRequest(operation, input, baseUrl)
    const extra = Object.entries(options.headers?.(operation) ?? {})
    for (const [name, value] of extra) request.headers.set(name, value)
    await signRequest(options.manifest, operation, request, options.token)
    // A redirect to another host drops only the standard sign-in headers; a hook's header would go along.
    if (extra.length) request.redirect = "manual"
    return send(NO_COMMAND, operation, request)
  }
}
