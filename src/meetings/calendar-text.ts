import { joinUrlWithoutQuery } from "./join-key.js"

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " }

/**
 * A line that gives a way into a meeting: a passcode, a password, a PIN or an access code. Bounded by letters and
 * digits, not `\b`, which knows only ASCII and would never match a Cyrillic word.
 */
const SECRET_LINE =
  /(?<![\p{L}\p{N}])(pass ?codes?|passwords?|pwd|pins?|access ?codes?|meeting ?codes?|kennwort|пароль|пин-?код|код доступа)(?![\p{L}\p{N}])|pwd=/iu

const htmlToText = (html: string): string =>
  html
    .replace(/<\s*br\s*\/?>/giu, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/giu, "\n")
    .replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>/giu, " $1 ")
    .replace(/<[^>]+>/gu, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gu, (_, name: string) => ENTITIES[name] ?? "")

/** Every web link without its query string or fragment, which is where passcodes ride (`pwd=`). */
export const withoutLinkQueries = (text: string): string =>
  text.replace(/https?:\/\/[^\s<>"')\]]+/giu, (url) => joinUrlWithoutQuery(url) ?? "")

/**
 * A calendar's text as the store keeps it: HTML reduced to text, links without their query strings, and each line
 * naming a passcode, password or PIN dropped — except from a title, where "PIN reset review" is a meeting's name.
 * `null` when nothing is left.
 */
export const calendarText = (
  text: string | null | undefined,
  { dropSecretLines = true }: { dropSecretLines?: boolean } = {},
): string | null => {
  if (!text) return null
  const kept = htmlToText(text)
    .split(/\r?\n/u)
    .map((line) =>
      withoutLinkQueries(line)
        .replace(/[ \t]+/gu, " ")
        .trim(),
    )
    .filter((line) => !dropSecretLines || !SECRET_LINE.test(line))
  const joined = kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
  return joined || null
}

/** The provider fields a calendar entry may keep in `metadata`: none of them can open a meeting. */
export const ENTRY_METADATA_KEYS = [
  "colorId",
  "guestsCanInviteOthers",
  "guestsCanModify",
  "guestsCanSeeOtherGuests",
  "hangoutLink",
  "locked",
  "privateCopy",
] as const

export const entryMetadata = (metadata: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  const kept: Record<string, unknown> = {}
  for (const key of ENTRY_METADATA_KEYS) {
    const value = metadata?.[key]
    if (typeof value === "string") kept[key] = withoutLinkQueries(value)
    else if (typeof value === "number" || typeof value === "boolean") kept[key] = value
  }
  return kept
}
