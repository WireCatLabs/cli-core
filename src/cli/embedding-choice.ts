import { CliError, type KeyringStore } from "@wirecat/cli-base"
import { type AISettings, endpoint } from "../analysis/settings.js"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import { DEFAULT_TEXT_MODEL } from "../embeddings/models.js"
import { isLocal, remoteModel } from "../embeddings/remote.js"
import { type AppIdentity, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { typedCommand } from "../runs/scope.js"
import type { ModelChoice } from "../services/embeddings.js"

export interface ModelOptions {
  embeddingProvider?: string
  model?: string
  baseUrl?: string
  dims?: number
  concurrency?: number
}

/** A local model id, or a remote model with its key from `models keys set`. */
export const embeddingChoice = (
  { model, embeddingProvider, baseUrl, dims, concurrency }: ModelOptions,
  app: AppIdentity,
  settings: AISettings,
  env: NodeJS.ProcessEnv,
  { needKey = true, keyring }: { needKey?: boolean; keyring?: KeyringStore | undefined } = {},
): ModelChoice => {
  let provider = embeddingProvider
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
  const key = embeddingKeys(app, env, keyring).read(keyName)?.key
  if (!key && needKey && baseUrl === undefined) {
    throw new CliError(
      "authentication_error",
      `no OpenAI key — \`${typedCommand(app.command, "models keys set openai")}\`, or OPENAI_API_KEY`,
    )
  }
  return { remote, ...(key ? { apiKey: key } : {}), ...(concurrency ? { concurrency } : {}) }
}

/**
 * Under `<PREFIX>_READ_ONLY`, refuses a query bound for an embedder off this machine. Nothing changes there, but the
 * lock keeps the owner's text from leaving: a stricter reading of WC-PERM-12.
 */
export const refuseRemoteQuery = (model: ModelChoice, app: AppIdentity, env: NodeJS.ProcessEnv): void => {
  if (typeof model === "string" || isLocal(model.remote.baseUrl)) return
  const lock = readOnlyLockOf(app, env)
  if (lock) throw readOnlyRefusal(lock, `send the query to ${new URL(model.remote.baseUrl).host}`)
}
