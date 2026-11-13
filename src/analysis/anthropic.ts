import { anthropic } from "../models/anthropic.js"
import { endpointFetch } from "../models/endpoint.js"
import type { AnalysisProvider, AnalysisResponse } from "./provider.js"

export const analyze = async (
  target: AnalysisProvider,
  system: string,
  input: string,
  maxTokens: number,
): Promise<AnalysisResponse> =>
  anthropic.complete(
    target,
    { purpose: "analysis", system, prompt: input, maxTokens },
    {},
    target.apiKey,
    endpointFetch(target.baseUrl, 120_000),
  )
