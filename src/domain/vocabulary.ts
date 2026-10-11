import { CliError } from "@wirecat/cli-base"

/** Search accent folding would make distinct names equal; canonical aliases retain their letters. */
export const normalizeVocabularyName = (input: string): string => {
  if (typeof input !== "string" || input.length > 200 || /[\p{Cc}\p{Cf}]/u.test(input))
    throw new CliError("validation_error", "a vocabulary name takes 1–200 characters without control characters")
  const value = input.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim()
  if (!value) throw new CliError("validation_error", "a vocabulary name must not be empty")
  return value
}

/** Similarity is a review hint; only exact normalized names resolve canonical records. */
export const vocabularySimilarity = (left: string, right: string): number => {
  const a = normalizeVocabularyName(left)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
  const b = normalizeVocabularyName(right)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (value: string) => {
    const chars = Array.from(value)
    return new Set(chars.slice(1).map((char, index) => `${chars[index]}${char}`))
  }
  const aa = grams(a)
  const bb = grams(b)
  if (aa.size + bb.size === 0) return 0
  const intersection = [...aa].filter((gram) => bb.has(gram)).length
  return (2 * intersection) / (aa.size + bb.size)
}
