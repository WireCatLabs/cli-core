/** Words of a query worth finding in a text: no operators, no field names, nothing shorter than three letters. */
export const queryWords = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[\p{L}_]+:/u, "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 2 && !["and", "or", "not"].includes(word))

/**
 * About `size` characters of `text` on one line, around the first word of `query` it holds, or its start when it
 * holds none: enough to tell a hit apart, a fraction of a whole email.
 */
export const excerpt = (text: string, query: string, size = 240): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= size) return flat
  const lower = flat.toLowerCase()
  const found = queryWords(query)
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
  const at = found.length ? Math.min(...found) : 0
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), flat.length - size))
  const end = start + size
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`
}

/** A hit with its excerpt, taken from where the words were found; the text of that place is not passed on. */
export const withExcerpt = <T extends { text: string; matchedText?: string }>(
  { matchedText, ...hit }: T,
  query: string,
): Omit<T, "matchedText"> & { excerpt: string } => ({ ...hit, excerpt: excerpt(matchedText ?? hit.text, query) })
