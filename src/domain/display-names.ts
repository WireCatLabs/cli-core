import { foldName } from "../resolve.js"

/** What a person can be shown as when their name has nothing to read. */
export interface NameFallbacks {
  username?: string | null
  phone?: string | null
  email?: string | null
}

const QUOTES: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["«", "»"],
  ["“", "”"],
  ["„", "“"],
  ["‘", "’"],
  ["`", "`"],
]

const READABLE = /[\p{L}\p{N}]/u

const unquoted = (text: string): string => {
  let at = text.replace(/\s+/gu, " ").trim()
  for (;;) {
    const pair = QUOTES.find(([open, close]) => at.length >= 2 && at.startsWith(open) && at.endsWith(close))
    if (pair === undefined) return at
    at = at.slice(pair[0].length, at.length - pair[1].length).trim()
  }
}

const given = (value: string | null | undefined): string | undefined => {
  const text = typeof value === "string" ? value.trim() : ""
  return text === "" ? undefined : text
}

/**
 * A name as it is shown: no wrapping quotes, no repeated or edge spaces. One with no letter or digit (`!`, `!$`) gives
 * way to the username, then the phone, then the email; the stored name stays as it came.
 */
export const displayName = (name: string | null | undefined, fallbacks: NameFallbacks = {}): string | null => {
  const cleaned = typeof name === "string" ? unquoted(name) : ""
  if (READABLE.test(cleaned)) return cleaned
  const username = given(fallbacks.username)
  return (
    (username === undefined ? undefined : username.startsWith("@") ? username : `@${username}`) ??
    given(fallbacks.phone) ??
    given(fallbacks.email) ??
    (cleaned === "" ? null : cleaned)
  )
}

/**
 * The name two people share when case, quotes, punctuation and word order are ignored: `"Ivanov Ivan"` and
 * `ivan IVANOV` give one key. `null` for a name with no letter or digit, which matches nobody.
 */
export const nameKey = (name: string | null | undefined): string | null => {
  if (typeof name !== "string") return null
  const words = foldName(unquoted(name))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
  return words.length === 0 ? null : words.sort().join(" ")
}
