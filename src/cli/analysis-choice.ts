import { CliError } from "@wirecat/cli-base"
import type { AnalysisProvider } from "../analysis/provider.js"
import { endpoint } from "../analysis/settings.js"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import type { AppIdentity } from "../ports/app.js"
import type { Settings } from "./settings.js"

export interface AnalysisOptions {
  provider?: string
  model?: string
  baseUrl?: string
}
export const analysisChoice = (
  options: AnalysisOptions,
  app: AppIdentity,
  settings: Settings,
  env: NodeJS.ProcessEnv,
): AnalysisProvider => {
  const configured = { ...settings.models?.default, ...settings.models?.analysis }
  settings = {
    ...settings,
    analysisProvider: configured.provider === "off" ? "agent" : (configured.provider ?? settings.analysisProvider),
    analysisModel: configured.model ?? settings.analysisModel,
    analysisBaseUrl: configured.base_url ?? settings.analysisBaseUrl,
  }
  const override =
    (options.provider !== undefined && options.provider !== (settings.analysisProvider ?? "agent")) ||
    (options.baseUrl !== undefined &&
      options.baseUrl.replace(/\/+$/, "") !== settings.analysisBaseUrl?.replace(/\/+$/, ""))
  const provider =
    options.provider ??
    (settings.analysisProvider && settings.analysisProvider !== "agent"
      ? settings.analysisProvider
      : options.baseUrl
        ? "openai"
        : "agent")
  if (provider === "agent")
    throw new CliError(
      "validation_error",
      "analysis_provider is agent; use your linking skill, or configure openai/anthropic to use --analyze",
    )
  if (provider !== "openai" && provider !== "anthropic")
    throw new CliError("validation_error", "analysis provider must be agent, openai or anthropic")
  const model = options.model ?? (override ? undefined : settings.analysisModel)
  if (!model?.trim()) throw new CliError("validation_error", "set analysis_model or give --model before --analyze")
  const customUrl = options.baseUrl ?? (override ? undefined : settings.analysisBaseUrl)
  const baseUrl = customUrl ?? (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")
  if (!endpoint(baseUrl))
    throw new CliError("validation_error", "use an HTTP/S analysis endpoint without credentials, query or fragment")
  const keyName = customUrl === undefined ? provider : endpointKeyName(baseUrl)
  const apiKey = embeddingKeys(app, env).read(keyName)?.key
  if (!apiKey && customUrl === undefined)
    throw new CliError("authentication_error", `no ${provider} key — use models text key set ${provider}`)
  return { provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) }
}
