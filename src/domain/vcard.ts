import { createHash } from "node:crypto"
import { typedPhone } from "./mentions.js"
import type { PhoneCountry } from "./phones.js"
import { WORD_BODY } from "./record-types.js"
import type { EnvelopeRecord, RecordRelation, RecordsEnvelope } from "./records.js"

export interface VcardOptions {
  provider: string
  account: string
  batchId: string
  /** The country a number without `+` is read in. Left out, such a number is kept as text and reported. */
  region?: PhoneCountry
}

export interface VcardIssue {
  /** The card's place in the file, from 0. */
  card: number
  message: string
}

interface Property {
  name: string
  params: Map<string, string[]>
  value: string
}

const MAX_ID = 512
const AS_WORD = new RegExp(`^${WORD_BODY}$`)

/** Whether a file is a vCard address book rather than a JSON or JSONL envelope. */
export const isVcard = (text: string): boolean => /^﻿?\s*BEGIN:VCARD\b/i.test(text)

const isQuotedPrintable = (line: string) => {
  const colon = line.indexOf(":")
  return /;(ENCODING=)?QUOTED-PRINTABLE\b/i.test(colon < 0 ? line : line.slice(0, colon))
}

/** Joins folded lines (RFC 6350 3.2) and quoted-printable soft breaks, which vCard 2.1 writes without indent. */
const unfolded = (text: string): string[] => {
  const lines: string[] = []
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const last = lines.length - 1
    const previous = lines[last]
    const soft = previous !== undefined && isQuotedPrintable(previous) && previous.endsWith("=")
    if (previous !== undefined && soft) lines[last] = previous.slice(0, -1) + raw.replace(/^[ \t]/, "")
    else if (previous !== undefined && /^[ \t]/.test(raw)) lines[last] = previous + raw.slice(1)
    else lines.push(raw)
  }
  return lines.filter((line) => line.trim() !== "")
}

/** Splits at the first `:` outside a quoted parameter value. */
const propertyOf = (line: string): Property | undefined => {
  let quoted = false
  let colon = -1
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted
    else if (line[index] === ":" && !quoted) {
      colon = index
      break
    }
  }
  if (colon < 0) return undefined
  const [head = "", ...rest] = line.slice(0, colon).split(";")
  const params = new Map<string, string[]>()
  for (const part of rest) {
    const equals = part.indexOf("=")
    // vCard 2.1 writes a bare type or encoding: `TEL;CELL;VOICE`, `;QUOTED-PRINTABLE`.
    const key =
      equals < 0 ? (/^(QUOTED-PRINTABLE|BASE64|8BIT|7BIT|B)$/i.test(part) ? "ENCODING" : "TYPE") : part.slice(0, equals)
    const values = (equals < 0 ? part : part.slice(equals + 1)).replaceAll('"', "").split(",")
    params.set(key.toUpperCase(), [...(params.get(key.toUpperCase()) ?? []), ...values.map((one) => one.toUpperCase())])
  }
  const name = head.replace(/^[^.]*\./, "").toUpperCase()
  return { name, params, value: line.slice(colon + 1) }
}

const encoder = new TextEncoder()

const decoded = (property: Property): string => {
  const encoding = property.params.get("ENCODING")?.[0]
  if (encoding !== "QUOTED-PRINTABLE") return property.value
  const bytes: number[] = []
  const { value } = property
  for (let index = 0; index < value.length; index += 1) {
    const hex = value.slice(index + 1, index + 3)
    if (value[index] === "=" && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      index += 2
    } else for (const byte of encoder.encode(value[index])) bytes.push(byte)
  }
  const charset = property.params.get("CHARSET")?.[0]?.toLowerCase() ?? "utf-8"
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes))
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes))
  }
}

/** The value's components (`N`, `ORG`), each with vCard 3.0/4.0's backslash escapes undone. */
const components = (value: string): string[] => {
  const parts: string[] = [""]
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string
    if (char === "\\" && index + 1 < value.length) {
      const next = value[index + 1] as string
      parts[parts.length - 1] += next === "n" || next === "N" ? "\n" : next
      index += 1
    } else if (char === ";") parts.push("")
    else parts[parts.length - 1] += char
  }
  return parts.map((part) => part.trim())
}

const textOf = (property: Property) => components(decoded(property)).join(";").trim()

/** E.164, or `undefined` when the number has no country of its own and none is given. */
const e164 = (typed: string, region: PhoneCountry | undefined): string | undefined => {
  const text = typed.replace(/^tel:/i, "").replace(/;.*$/, "").trim()
  const international = /^(\+|00)/.test(text)
  if (!international && region === undefined) return undefined
  const value = typedPhone(text, region === undefined ? {} : { phoneCountries: [region] })?.value
  return value?.startsWith("+") ? value : undefined
}

const foldedName = (name: string) => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()

const hashed = (prefix: string, parts: string[]) =>
  `${prefix}${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)}`

const organizationId = (name: string) => {
  const id = `org:${foldedName(name)}`
  return id.length <= MAX_ID ? id : hashed("org:", [foldedName(name)])
}

const titleWord = (title: string) => {
  const word = title.toLowerCase().trim().replace(/\s+/g, "-")
  return AS_WORD.test(word) ? word : undefined
}

const nameOf = (properties: Property[]): string | undefined => {
  const full = properties.find(({ name }) => name === "FN")
  if (full && textOf(full)) return textOf(full)
  const structured = properties.find(({ name }) => name === "N")
  if (!structured) return undefined
  const [family = "", given = "", additional = ""] = components(decoded(structured))
  return [given, additional, family].filter(Boolean).join(" ") || undefined
}

const SKIPPED = new Set(["PHOTO", "LOGO", "SOUND", "KEY"])

const cardsOf = (text: string): Property[][] => {
  const cards: Property[][] = []
  let card: Property[] | undefined
  for (const line of unfolded(text)) {
    const property = propertyOf(line)
    if (!property) continue
    if (property.name === "BEGIN" && property.value.trim().toUpperCase() === "VCARD") card = []
    else if (property.name === "END" && property.value.trim().toUpperCase() === "VCARD") {
      if (card) cards.push(card)
      card = undefined
    } else if (card && !SKIPPED.has(property.name)) card.push(property)
  }
  return cards
}

/**
 * A vCard file (2.1, 3.0 or 4.0) as a records envelope: one person per card, matched later by its numbers and
 * addresses, and one organization per `ORG` name the person is a member of. Nothing is guessed: a national number
 * is read only in `region`, and a card says nothing about a person it does not hold.
 */
export const envelopeOfVcard = (
  text: string,
  { provider, account, batchId, region }: VcardOptions,
): { envelope: RecordsEnvelope; issues: VcardIssue[] } => {
  const issues: VcardIssue[] = []
  const people: EnvelopeRecord[] = []
  const organizations = new Map<string, EnvelopeRecord>()
  const seen = new Set<string>()
  for (const [index, properties] of cardsOf(text).entries()) {
    const values = (wanted: string) =>
      properties
        .filter(({ name }) => name === wanted)
        .map(textOf)
        .filter(Boolean)
    const name = nameOf(properties)
    const phones: string[] = []
    const unread: string[] = []
    for (const typed of values("TEL")) {
      const value = e164(typed, region)
      if (value !== undefined) {
        if (!phones.includes(value)) phones.push(value)
      } else {
        unread.push(typed)
        issues.push({
          card: index,
          message: `${typed} has no country code${region === undefined ? " and no region was given" : ` in ${region}`}: kept, not matched`,
        })
      }
    }
    const emails = [...new Set(values("EMAIL").map((one) => one.replace(/^mailto:/i, "").toLowerCase()))]
    const uid = values("UID")[0]
    const externalId = uid?.slice(0, MAX_ID) ?? hashed("vcard:", [name ?? "", ...[...phones].sort(), ...emails.sort()])
    if (seen.has(externalId)) {
      issues.push({ card: index, message: `another card of the file is ${externalId}: left out` })
      continue
    }
    seen.add(externalId)
    const organization = properties.find(({ name }) => name === "ORG")
    const organizationName = organization ? components(decoded(organization))[0] : undefined
    const title = values("TITLE")[0]
    const relations: RecordRelation[] = []
    if (organizationName) {
      const id = organizationId(organizationName)
      if (!organizations.has(id))
        organizations.set(id, {
          key: id,
          type: "organization",
          external_id: id,
          operation: "upsert",
          fields: { name: organizationName },
        })
      const as = title === undefined ? undefined : titleWord(title)
      relations.push({ role: "member-of", type: "organization", external_id: id, ...(as ? { as } : {}) })
    }
    people.push({
      key: `person:${externalId}`,
      type: "person",
      external_id: externalId,
      operation: "upsert",
      fields: {
        ...(name === undefined ? {} : { name }),
        ...(phones.length ? { phone: phones } : {}),
        ...(emails.length ? { email: emails } : {}),
        ...(unread.length ? { phone_unread: unread } : {}),
        ...(organizationName ? { organization: organizationName } : {}),
        ...(title === undefined ? {} : { title }),
      },
      ...(relations.length ? { relations } : {}),
    })
  }
  return {
    envelope: {
      schema_version: 1,
      source: { provider, account, batch_id: batchId },
      records: [...organizations.values(), ...people],
    },
    issues,
  }
}
