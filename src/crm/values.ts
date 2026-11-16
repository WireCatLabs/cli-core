import type { CrmField, CrmValue } from "../domain/crm.js"
import { withoutFileLinks } from "./files.js"

/** A JSON object as a CRM sends one; anything else is not read as a record. */
export type CrmRaw = Record<string, unknown>

export const isRaw = (value: unknown): value is CrmRaw =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const fieldOf = (value: unknown, key: string): unknown => (isRaw(value) ? value[key] : undefined)

export const rawsOf = (value: unknown): CrmRaw[] => (Array.isArray(value) ? value.filter(isRaw) : [])

/** A string or a number as trimmed text; an empty one, and anything else, is null. */
export const text = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null
  const trimmed = String(value).trim()
  return trimmed === "" ? null : trimmed
}

/** CRMs send `0` for "no link" (Bitrix24's `companyId`, Kommo's `responsible_user_id` of nobody). */
export const id = (value: unknown): string | null => {
  const found = text(value)
  return found === null || found === "0" ? null : found
}

export const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(id).filter((one): one is string => one !== null) : []

export const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null
  const found = Number(value)
  return Number.isFinite(found) ? found : null
}

/**
 * A time as UTC ISO (WC-OUT-13), from an ISO string with any offset or epoch seconds, as Kommo sends them; a number
 * above 1e11 is read as milliseconds.
 */
export const time = (value: unknown): string | null => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null
    return new Date(value > 1e11 ? value : value * 1000).toISOString()
  }
  const found = text(value)
  if (found === null) return null
  const parsed = new Date(found)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** Epoch milliseconds, as the CRM port keeps times. */
export const epoch = (value: unknown): number | null => {
  const found = time(value)
  return found === null ? null : Date.parse(found)
}

/**
 * Money as a decimal string in its currency, both or neither; `0` is no amount, as CRMs that give every deal a
 * currency send it. A string amount is kept as sent: `toFixed` would add the double's error from about 1e10.
 */
export const amountOf = (value: unknown, currency: unknown): { amount: string | null; currency: string | null } => {
  const found = number(value)
  const code = text(currency)?.toUpperCase() ?? null
  if (found === null || found <= 0 || code === null) return { amount: null, currency: null }
  return { amount: typeof value === "string" ? value.trim() : String(found), currency: code }
}

export const fullName = (...parts: unknown[]): string | null =>
  parts
    .map(text)
    .filter((part): part is string => part !== null)
    .join(" ") || null

const optionLabel = (field: CrmField, option: unknown) =>
  field.options?.find(({ id }) => id === String(option))?.label ?? String(option)

/**
 * A record's custom values, by code, as the port keeps them: each with its field's label, and a list field's option
 * ids turned into their labels with `option_id` beside (both lists on a multiple field). A file field's tokened link
 * is removed, so it reaches neither the store nor an answer.
 */
export const crmValuesOf = (
  values: Readonly<Record<string, unknown>>,
  fields: readonly CrmField[],
): Record<string, CrmValue> => {
  const byCode = new Map(fields.map((field) => [field.code, field]))
  return Object.fromEntries(
    Object.entries(values).map(([code, value]): [string, CrmValue] => {
      const field = byCode.get(code)
      const label = field?.label ?? null
      if (!field?.options) return [code, { label, value: withoutFileLinks(value) }]
      if (Array.isArray(value))
        return [code, { label, value: value.map((one) => optionLabel(field, one)), option_id: value.map(String) }]
      return [code, { label, value: optionLabel(field, value), option_id: String(value) }]
    }),
  )
}
