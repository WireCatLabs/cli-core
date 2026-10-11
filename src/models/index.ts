import { CliError } from "@wirecat/cli-base"
import { endpoint } from "./endpoint.js"
import { openai } from "./openai.js"
import { type ModelAdapter, type ModelAnswer, type ModelRequest, type ModelTarget, validateImages } from "./types.js"

export type { ModelSettings } from "./settings.js"
export { modelTarget } from "./settings.js"
export type { ModelAdapter, ModelAnswer, ModelImage, ModelRequest, ModelTarget } from "./types.js"

export interface GatewayDeps {
  resolve: (purpose: string) => ModelTarget | undefined
  consent: (request: ModelRequest, target: ModelTarget) => boolean | Promise<boolean>
  key?: (provider: string, target: ModelTarget) => string | undefined | Promise<string | undefined>
  adapters?: Readonly<Record<string, ModelAdapter>>
  fetch?: typeof fetch
  signal?: AbortSignal
}

export const modelGateway = (deps: GatewayDeps) => ({
  complete: async (request: ModelRequest): Promise<ModelAnswer> => {
    if (deps.signal?.aborted) throw new CliError("cancelled", "model request cancelled")
    const target = deps.resolve(request.purpose)
    if (!target || target.provider === "off")
      throw new CliError(
        "configuration_error",
        `models.${request.purpose}.provider is not configured; no model was called`,
      )
    if (
      !request.purpose ||
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      typeof request.prompt !== "string"
    )
      throw new CliError("validation_error", "a model request needs a purpose, prompt and positive whole maxTokens")
    validateImages(request.images)
    let adapter = deps.adapters?.[target.provider]
    if (!adapter && target.provider === "openai") adapter = openai
    if (!adapter && target.provider === "anthropic") adapter = (await import("./anthropic.js")).anthropic
    if (!adapter) throw new CliError("validation_error", `no model adapter for ${target.provider}`)
    if (request.images !== undefined && adapter.images !== true)
      throw new CliError("validation_error", "the model adapter does not support image inputs")
    const options = adapter.validate(request.options ?? {})
    const baseUrl = target.baseUrl ?? adapter.baseUrl
    if (!target.model.trim() || !endpoint(baseUrl))
      throw new CliError(
        "validation_error",
        "a model target needs a model and an HTTP/S endpoint without credentials, query or fragment",
      )
    if (!(await deps.consent(request, { ...target, baseUrl })))
      throw new CliError("permission_error", `model consent for ${request.purpose} is missing; no data was sent`)
    const apiKey = await deps.key?.(target.provider, target)
    if (deps.signal?.aborted) throw new CliError("cancelled", "model request cancelled")
    const fetcher = deps.fetch ?? fetch
    let limited = false
    const cancellable: typeof fetch = async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const response = await fetcher(input, {
        ...init,
        signal: deps.signal ? AbortSignal.any([deps.signal, ...(signal ? [signal] : [])]) : signal,
      })
      if (response.status === 429) limited = true
      return response
    }
    try {
      const answer = await adapter.complete({ ...target, baseUrl }, request, options, apiKey, cancellable)
      if (deps.signal?.aborted) throw new Error("cancelled")
      if (typeof answer.text !== "string" || !Number.isSafeInteger(answer.tokens) || answer.tokens < 1)
        throw new Error("incomplete")
      return { ...answer, provider: target.provider, model: target.model }
    } catch {
      if (limited)
        throw new CliError("rate_limited", `${request.purpose} provider rate limit reached; no result was stored`)
      throw new CliError(
        "invalid_response",
        `${request.purpose} provider failed or returned an incomplete response; no result was stored`,
      )
    }
  },
})
