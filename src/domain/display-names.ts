import { foldName } from "../resolve.js"

/** What a person can be shown as when their name has nothing to read. */
export interface NameFallbacks {
  /** A name one of the person's accounts carries: a real name beats a handle. */
  name?: string | null
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

/** What a source writes when it has no name: no name at all. */
const PLACEHOLDERS = new Set(["null", "undefined", "none", "без имени", "deleted account", "удалённый аккаунт"])

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
 * A name as it is shown: no wrapping quotes, no repeated or edge spaces. One with no letter or digit (`!`, `!$`), or a
 * placeholder such as `null` or «Без имени», gives way to an account's name, then the username, the phone, the email;
 * the stored name stays as it came.
 */
export const displayName = (name: string | null | undefined, fallbacks: NameFallbacks = {}): string | null => {
  const unwrapped = typeof name === "string" ? unquoted(name) : ""
  const cleaned = PLACEHOLDERS.has(unwrapped.toLowerCase()) ? "" : unwrapped
  if (READABLE.test(cleaned)) return cleaned
  const borrowed = fallbacks.name === undefined || fallbacks.name === null ? null : displayName(fallbacks.name)
  if (borrowed !== null && READABLE.test(borrowed) && !borrowed.startsWith("@")) return borrowed
  const username = given(fallbacks.username)
  return (
    (username === undefined ? undefined : username.startsWith("@") ? username : `@${username}`) ??
    given(fallbacks.phone) ??
    given(fallbacks.email) ??
    (cleaned === "" ? null : cleaned)
  )
}

const present = (value: string | null | undefined): string | null =>
  typeof value === "string" && value !== "" ? value : null

/** One identity of a person, as `takeFallbacks` reads it. */
export interface FallbackSource {
  provider: string
  id: string
  name: string | null
  username: string | null
  phone?: string | null
  email?: string | null
}

/**
 * Fills what is still missing in `into` from one more identity, read in the order the identities were stored: the first
 * readable name that is no handle, the first username, phone and address. `people list` and a person's record give
 * the same shown name because both fill it here.
 */
export const takeFallbacks = (into: Required<NameFallbacks>, identity: FallbackSource): Required<NameFallbacks> => {
  const named = displayName(identity.name)
  if (into.name === null && isReadable(named) && !named?.startsWith("@")) into.name = named
  into.username ??= present(identity.username)
  into.phone ??= present(identity.phone) ?? (identity.provider === "phone" ? identity.id : null)
  into.email ??= present(identity.email) ?? (identity.provider === "email" ? identity.id : null)
  return into
}

export const noFallbacks = (): Required<NameFallbacks> => ({ name: null, username: null, phone: null, email: null })

/**
 * The name two people share when case, quotes, punctuation and word order are ignored: `"Ivanov Ivan"` and
 * `ivan IVANOV` give one key. `null` for a name with no letter or digit, which matches nobody.
 */
export const nameKey = (name: string | null | undefined): string | null => {
  if (typeof name !== "string") return null
  const unwrapped = unquoted(name)
  if (PLACEHOLDERS.has(unwrapped.toLowerCase())) return null
  const words = foldName(unwrapped)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
  return words.length === 0 ? null : words.sort().join(" ")
}

/** Whether a shown name has anything to read: not null, not only punctuation. */
export const isReadable = (shown: string | null): boolean => shown !== null && READABLE.test(shown)
