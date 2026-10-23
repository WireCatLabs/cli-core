import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type { AnalysisConsentFilter } from "../../analysis/consents.js"
import { analysisConsent } from "../../entities/index.js"
import { type QueryWords, queryTerms } from "../list-query.js"

export const ANALYSIS_CONSENTS_QUERY: QueryRegistry = {
  entity: "analysis_consent",
  backend: "native",
  fields: queryFieldsOf(analysisConsent, {
    native: ["chat", "provider"],
    examples: { chat: "chat:7", provider: 'provider:"openai:https://example.test/v1"' },
  }).map((field) =>
    field.native
      ? { ...field, operators: field.operators.filter((operator) => operator === "term" || operator === "phrase") }
      : field,
  ),
}

export const analysisConsentFilter = (words: QueryWords): AnalysisConsentFilter | undefined => {
  const terms = queryTerms(words, ANALYSIS_CONSENTS_QUERY, "conversations consents list")
  if (terms.size === 0) return undefined
  const chat = terms.get("chat"),
    provider = terms.get("provider")
  return { ...(chat === undefined ? {} : { chat }), ...(provider === undefined ? {} : { provider }) }
}
