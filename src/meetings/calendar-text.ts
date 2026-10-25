import { joinUrlWithoutQuery } from "./join-key.js"

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " }

/** A line that gives a way into a meeting: a passcode, a password, a PIN or an access code. */
const SECRET_LINE =
  /\b(pass ?codes?|passwords?|pwd|pins?|access ?codes?|meeting ?codes?|kennwort|пароль|пин-?код|код доступа)\b|pwd=/iu

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
 * A calendar's text as the store keeps it: HTML reduced to text, each line naming a passcode, password or PIN
 * dropped, and links without their query strings. `null` when nothing is left.
 */
export const calendarText = (text: string | null | undefined): string | null => {
  if (!text) return null
  const kept = htmlToText(text)
    .split(/\r?\n/u)
    .map((line) =>
      withoutLinkQueries(line)
        .replace(/[ \t]+/gu, " ")
        .trim(),
    )
    .filter((line) => !SECRET_LINE.test(line))
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
  "recurring_event_id",
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
