import { CliError, type KeyringStore } from "@wirecat/cli-base"
import type { AnalysisProvider } from "../analysis/provider.js"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import { sharedModel } from "../models/ai.js"
import { refuseModelAddress } from "../models/local-only.js"
import type { AppIdentity } from "../ports/app.js"
import type { Settings } from "./settings.js"

export interface AnalysisOptions {
  analysisProvider?: string
  model?: string
  baseUrl?: string
}
export const analysisChoice = (
  options: AnalysisOptions,
  app: AppIdentity,
  settings: Settings,
  env: NodeJS.ProcessEnv,
  keyring?: KeyringStore,
): AnalysisProvider => {
  const configured = { ...settings.models?.default, ...settings.models?.analysis }
  // `off` and no provider both leave the linking to the agent.
  const saved = configured.provider === undefined || configured.provider === "off" ? "agent" : configured.provider
  const override =
    (options.analysisProvider !== undefined && options.analysisProvider !== saved) ||
    (options.baseUrl !== undefined && options.baseUrl.replace(/\/+$/, "") !== configured.base_url?.replace(/\/+$/, ""))
  const provider = options.analysisProvider ?? (saved !== "agent" ? saved : options.baseUrl ? "openai" : "agent")
  // Nothing configured for linking (not `off`): the AI model the owner chose for every tool.
  const shared =
    provider === "agent" && configured.provider === undefined && options.analysisProvider === undefined
      ? sharedModel({ app, env, keyring })
      : undefined
  if (shared) {
    const { target, key } = shared
    refuseModelAddress(env, target.baseUrl, "chat messages")
    if (target.provider !== "openai" && target.provider !== "anthropic")
      throw new CliError("validation_error", "analysis provider must be agent, openai or anthropic")
    return {
      provider: target.provider,
      model: options.model ?? target.model,
      baseUrl: target.baseUrl,
      ...(key ? { apiKey: key } : {}),
    }
  }
  if (provider === "agent")
    throw new CliError(
      "validation_error",
      "models.analysis.provider is off or not set and no AI model is chosen, so the agent links the chat: use your linking skill, choose a model with `memo models ai set`, or set models.analysis.provider to openai or anthropic to use --analyze",
    )
  if (provider !== "openai" && provider !== "anthropic")
    throw new CliError("validation_error", "analysis provider must be agent, openai or anthropic")
  const model = options.model ?? (override ? undefined : configured.model)
  if (!model?.trim())
    throw new CliError("validation_error", "set models.analysis.model or give --model before --analyze")
  const customUrl = options.baseUrl ?? (override ? undefined : configured.base_url)
  const baseUrl = customUrl ?? (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")
  refuseModelAddress(env, baseUrl, "chat messages")
  const keyName = customUrl === undefined ? provider : endpointKeyName(baseUrl)
  const apiKey = embeddingKeys(app, env, keyring).read(keyName)?.key
  if (!apiKey && customUrl === undefined)
    throw new CliError("authentication_error", `no ${provider} key — use models keys set ${provider}`)
  return { provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) }
}
