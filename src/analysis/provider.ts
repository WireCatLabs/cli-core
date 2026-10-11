import { CliError } from "@wirecat/cli-base"
import { modelGateway } from "../models/index.js"
import { endpoint } from "./settings.js"

export interface AnalysisProvider {
  provider: "openai" | "anthropic"
  model: string
  baseUrl: string
  apiKey?: string
}
export interface AnalysisResponse {
  text: string
  tokens: number
}
export type AnalysisRequest = (system: string, input: string, maxTokens: number) => Promise<AnalysisResponse>
export const providerIdentity = (target: AnalysisProvider) => `${target.provider}:${target.baseUrl.replace(/\/+$/, "")}`

export const openAnalysis = (target: AnalysisProvider, signal?: AbortSignal): AnalysisRequest => {
  if (!endpoint(target.baseUrl)) throw new CliError("validation_error", "invalid analysis endpoint")
  const gateway = modelGateway({
    signal,
    resolve: () => target,
    key: () => target.apiKey,
    // The analysis command checks per-chat consent before each batch.
    consent: () => true,
  })
  return async (system, input, maxTokens) => gateway.complete({ purpose: "analysis", system, prompt: input, maxTokens })
}
