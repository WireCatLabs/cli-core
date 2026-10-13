import type { Section } from "../../readers/types.js"
import { normalize } from "../normalize.js"

export type DocumentMetadata = Record<string, string | string[]>

/** The fields a search can match; `folded` holds them as the search folds a query, so SQL can compare them. */
export const FOLDED_FIELDS = ["title", "site", "language", "author"] as const

/** What a reader found about a file, as one JSON text for `documents.metadata`; `null` when there is none. */
export const encodeDocumentMetadata = (
  meta: DocumentMetadata | undefined,
  sections: Section[] | undefined,
): string | null => {
  if (!meta && !sections?.length) return null
  const folded: Record<string, string | string[]> = {}
  for (const field of FOLDED_FIELDS) {
    const value = meta?.[field]
    if (typeof value === "string" && value !== "") folded[field] = normalize(value)
  }
  const keywords = meta?.keywords
  if (Array.isArray(keywords) && keywords.length) folded.keywords = keywords.map(normalize)
  return JSON.stringify({ meta: meta ?? {}, folded, sections: sections ?? [] })
}

export const languageOf = (meta: DocumentMetadata | undefined): string | null => {
  const language = meta?.language
  return typeof language === "string" && language !== "" ? language : null
}
