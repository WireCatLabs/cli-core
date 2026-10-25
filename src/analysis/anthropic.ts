import { anthropic } from "../models/anthropic.js"
import type { AnalysisProvider, AnalysisResponse } from "./provider.js"

export const analyze = async (
  target: AnalysisProvider,
  system: string,
  input: string,
  maxTokens: number,
): Promise<AnalysisResponse> =>
  anthropic.complete(target, { purpose: "analysis", system, prompt: input, maxTokens }, {}, target.apiKey, fetch)
// probe for #2019, not for merge
