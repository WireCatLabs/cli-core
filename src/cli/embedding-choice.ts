import { CliError } from "@wirecat/cli-base"
import { type AISettings, endpoint } from "../analysis/settings.js"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import { DEFAULT_TEXT_MODEL } from "../embeddings/models.js"
import { remoteModel } from "../embeddings/remote.js"
import type { AppIdentity } from "../ports/app.js"
import type { ModelChoice } from "../services/embeddings.js"

export interface ModelOptions {
  model?: string
  provider?: string
  baseUrl?: string
  dims?: number
  concurrency?: number
}

/** A local model id, or a remote model with its key from `models text key set`. */
export const embeddingChoice = (
  { model, provider, baseUrl, dims, concurrency }: ModelOptions,
  app: AppIdentity,
  settings: AISettings,
  env: NodeJS.ProcessEnv,
  { needKey = true }: { needKey?: boolean } = {},
): ModelChoice => {
  const flagsChooseProvider =
    (provider !== undefined && provider !== (settings.embeddingProvider ?? "local")) ||
    (baseUrl !== undefined && baseUrl.replace(/\/+$/, "") !== settings.embeddingBaseUrl?.replace(/\/+$/, ""))
  provider ??= flagsChooseProvider ? "openai" : (settings.embeddingProvider ?? "local")
  baseUrl ??= flagsChooseProvider ? undefined : settings.embeddingBaseUrl
  model ??= flagsChooseProvider ? undefined : settings.embeddingModel
  dims ??= flagsChooseProvider ? undefined : settings.embeddingDims
  if (provider === "local") {
    if (baseUrl !== undefined || dims !== undefined)
      throw new CliError("validation_error", "local embeddings do not take --base-url or --dims")
    return model ?? DEFAULT_TEXT_MODEL
  }
  if (baseUrl !== undefined && !endpoint(baseUrl))
    throw new CliError("validation_error", "use an HTTP/S --base-url without credentials, query or fragment")
  if (provider !== undefined && provider !== "openai") {
    throw new CliError("validation_error", `no provider ${provider} — openai, or a server with --base-url`)
  }
  const remote = remoteModel({
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(dims ? { dims } : {}),
  })
  const keyName = baseUrl === undefined ? "openai" : endpointKeyName(baseUrl)
  const key = embeddingKeys(app, env).read(keyName)?.key
  if (!key && needKey && baseUrl === undefined) {
    throw new CliError(
      "authentication_error",
      `no OpenAI key — \`${app.command} models text key set openai\`, or OPENAI_API_KEY`,
    )
  }
  return { remote, ...(key ? { apiKey: key } : {}), ...(concurrency ? { concurrency } : {}) }
}
