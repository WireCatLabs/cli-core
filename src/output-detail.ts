/**
 * How much of a found message or email an answer carries. The default is what an agent needs to name it, place it
 * and decide whether to read it: its reference, chat or thread, time, people and an excerpt, never its whole text.
 * `brief` keeps what tells hits apart; `full` adds the whole text and every provider field.
 */
export type Detail = "brief" | "default" | "full"

export const DETAILS = ["brief", "full"] as const

/** Message fields mail never has and a messenger hit rarely fills; a null one is noise. */
const RARELY_SET = ["editedAt", "replyTo", "forwardedFrom", "reactions"]

const BRIEF = ["locator", "chatTitle", "timestamp", "senderName", "excerpt", "score"]

type Item = Record<string, unknown>

const isHit = (value: unknown): value is Item =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Item).locator === "string" &&
  typeof (value as Item).text === "string"

const shaped = (hit: Item, detail: Detail): Item => {
  if (detail === "brief")
    return Object.fromEntries(
      BRIEF.flatMap((key) => (hit[key] === undefined || hit[key] === null ? [] : [[key, hit[key]]])),
    )
  const { text, providerMetadata, ...rest } = hit
  for (const key of RARELY_SET) if (rest[key] === null) delete rest[key]
  // An email's people are in `email`; the provider block repeated its cc and bcc.
  const metadata = rest.email ? undefined : providerMetadata
  return {
    ...rest,
    ...(typeof rest.excerpt === "string" ? {} : { text }),
    ...(metadata === undefined ? {} : { providerMetadata: metadata }),
  }
}

/** `value` with every found message in it, at the top or in `items`, cut to `detail`; anything else unchanged. */
export const atDetail = <T>(value: T, detail: Detail = "default"): T => {
  if (detail === "full") return value
  if (Array.isArray(value)) return value.map((item) => (isHit(item) ? shaped(item, detail) : item)) as T
  if (isHit(value)) return shaped(value, detail) as T
  if (typeof value === "object" && value !== null && Array.isArray((value as Item).items))
    return { ...(value as Item), items: atDetail((value as Item).items, detail) } as T
  return value
}
