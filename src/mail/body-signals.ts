import { jsonLdOf, schemaTypesOf } from "./mail-types.js"

const MAX_TYPES = 10
const MAX_VALUE_CHARS = 100
const ICS_HEAD_BYTES = 64 * 1024
/** The few schema.org values that name the order, parcel or booking an email is about. */
const SCHEMA_FIELDS = ["orderNumber", "orderStatus", "trackingNumber", "reservationNumber", "reservationStatus"]
const CALENDAR_PARTS = new Set(["text/calendar", "application/ics"])

export interface CalendarPart {
  mimeType: string
  /** The Content-Type `method` parameter, as postal-mime gives it. */
  method?: string | undefined
  content: ArrayBuffer | Uint8Array | string
}

/** What `mailHeadersOf` cannot see in the header: kept beside it under `emails.headers`, never the HTML itself. */
export type BodySignals = Record<string, string | string[] | Record<string, string>>

const ldValue = (blocks: readonly string[], name: string): string | undefined => {
  const pattern = new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,${MAX_VALUE_CHARS}})"`)
  for (const block of blocks) {
    const found = pattern.exec(block)?.[1]
    if (found !== undefined) return found
  }
  return undefined
}

const itemValue = (html: string, name: string): string | undefined => {
  const tag = new RegExp(`<[^<>]*\\bitemprop\\s*=\\s*["']?${name}\\b[^<>]*>`, "i").exec(html)?.[0]
  return tag === undefined
    ? undefined
    : new RegExp(`\\bcontent\\s*=\\s*["']([^"'<>]{1,${MAX_VALUE_CHARS}})["']`, "i").exec(tag)?.[1]
}

const schemaFieldsOf = (html: string): Record<string, string> => {
  const blocks = jsonLdOf(html)
  const fields: Record<string, string> = {}
  for (const name of SCHEMA_FIELDS) {
    const value = (ldValue(blocks, name) ?? itemValue(html, name))?.trim()
    if (value) fields[name] = value
  }
  return fields
}

const icsHead = (content: CalendarPart["content"]): string =>
  typeof content === "string"
    ? content.slice(0, ICS_HEAD_BYTES)
    : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content))
        .subarray(0, ICS_HEAD_BYTES)
        .toString("utf8")

/** REQUEST, CANCEL, REPLY (RFC 5546): an invitation, its cancellation or someone's answer. */
const calendarMethodOf = (parts: readonly CalendarPart[]): string | undefined => {
  const part = parts.find(({ mimeType }) => CALENDAR_PARTS.has(mimeType.toLowerCase()))
  if (part === undefined) return undefined
  const method = part.method ?? /^METHOD:[ \t]*([A-Za-z-]+)/m.exec(icsHead(part.content))?.[1]
  return method?.trim().toLowerCase() || undefined
}

/** schema.org type names and a few of their values, and a calendar part's method. */
export const bodySignalsOf = (html: string | undefined, parts: readonly CalendarPart[]): BodySignals => {
  const types = html ? schemaTypesOf(html).slice(0, MAX_TYPES) : []
  const fields = types.length > 0 && html ? schemaFieldsOf(html) : {}
  const method = calendarMethodOf(parts)
  return {
    ...(types.length > 0 ? { "schema-types": types } : {}),
    ...(Object.keys(fields).length > 0 ? { "schema-fields": fields } : {}),
    ...(method === undefined ? {} : { "calendar-method": method }),
  }
}
