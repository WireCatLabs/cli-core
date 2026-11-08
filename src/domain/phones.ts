import { CliError } from "@wirecat/cli-base"
import { PHONE_PLANS } from "./phone-plans.generated.js"

export type PhoneCountry = (typeof PHONE_PLANS)[number]["country"]

export const PHONE_COUNTRIES = PHONE_PLANS.map((plan) => plan.country)

/** Without the setting a number with no `+` is read as Russian, as before the setting existed. */
export const DEFAULT_PHONE_COUNTRIES: readonly PhoneCountry[] = ["ru"]

/** `es,ru` → the countries in that order; the first that a number fits names it. */
export const parsePhoneCountries = (value: string): PhoneCountry[] => {
  const countries = value
    .split(/[\s,]+/)
    .map((one) => one.trim().toLowerCase())
    .filter(Boolean)
  const unknown = countries.filter((one) => !PHONE_COUNTRIES.includes(one as PhoneCountry))
  if (countries.length === 0 || unknown.length > 0)
    throw new CliError(
      "validation_error",
      `phone_countries takes country codes, ${unknown.length > 0 ? `not ${unknown.join(", ")}` : "at least one"}: ` +
        PHONE_COUNTRIES.join(", "),
    )
  return [...new Set(countries)] as PhoneCountry[]
}

const PLANS = new Map(
  PHONE_PLANS.map((plan) => [
    plan.country,
    {
      code: plan.code,
      trunk: plan.trunk ? new RegExp(`^(?:${plan.trunk})`) : null,
      lengths: new Set<number>(plan.lengths),
      valid: new RegExp(`^(?:${plan.valid})$`),
      mobile: plan.mobile === null ? null : new RegExp(`^(?:${plan.mobile})$`),
    },
  ]),
)

export interface NationalPhone {
  /** E.164: `+` and the country code before the national number. */
  value: string
  /** The national number, the part every spelling of the number shares. */
  national: string
  mobile: boolean
}

/**
 * Digits written without `+`, read in the first of `countries` whose plan they fit: with the trunk prefix
 * (`0`, `06`, `8`), as they are, or after the country code typed without its `+`. `anyType` takes landlines too;
 * without it only mobiles count, since bare landline-shaped digits are mostly order and account numbers.
 */
export const nationalPhone = (
  digits: string,
  countries: readonly string[],
  { anyType }: { anyType: boolean },
): NationalPhone | undefined => {
  for (const country of countries) {
    const plan = PLANS.get(country as PhoneCountry)
    if (!plan) continue
    const readings = [
      ...(plan.trunk?.test(digits) ? [digits.replace(plan.trunk, "")] : []),
      digits,
      ...(digits.startsWith(plan.code) ? [digits.slice(plan.code.length)] : []),
    ]
    for (const national of readings) {
      if (!plan.lengths.has(national.length) || !plan.valid.test(national)) continue
      const mobile = plan.mobile?.test(national) ?? false
      if (anyType || mobile) return { value: `+${plan.code}${national}`, national, mobile }
    }
  }
  return undefined
}

export interface PhoneOptions {
  /** Where a number written without `+` is read, first match first: the store's `phone_countries`. */
  phoneCountries?: readonly string[]
}

/**
 * A number typed into a search, read as if a phone word stood before it, and the national number every stored
 * spelling of it ends with — at least 8 digits, so a short tail does not match unrelated numbers.
 */
export const typedPhone = (
  typed: string,
  { phoneCountries = DEFAULT_PHONE_COUNTRIES }: PhoneOptions = {},
): { value: string; national: string | null } | undefined => {
  const text = typed.trim()
  if (!/^\+?[\d\s().\-–]+$/.test(text)) return undefined
  const digits = text.replace(/\(0\)/, "").replace(/\D/g, "").replace(/^00/, "")
  if (digits.length < 7 || digits.length > 15) return undefined
  const national = nationalPhone(digits, phoneCountries, { anyType: true })
  const tail = national?.national ?? digits.replace(/^0+/, "")
  return {
    value: text.startsWith("+") || /^00/.test(text) ? `+${digits}` : (national?.value ?? digits),
    national: tail.length >= 8 ? tail : null,
  }
}

/**
 * A phone as a source typed it, as E.164: `null` for a number written without `+` or `00` when no region is given,
 * nothing when it is no phone. Only the source says which country a national number is from: the store's
 * `phone_countries` setting reads `4155550100` as Russian, so it never decides an identifier.
 */
export const e164Of = (phone: string, region: string | undefined): string | null | undefined => {
  if (/^\s*(\+|00)/.test(phone)) return typedPhone(phone)?.value
  if (typedPhone(phone) === undefined) return undefined
  if (region === undefined) return null
  const digits = phone.replace(/\(0\)/, "").replace(/\D/g, "")
  return nationalPhone(digits, [region], { anyType: true })?.value
}

/** The messengers that keep a contact's number as bare international digits, the `+` left off. */
export const BARE_INTERNATIONAL_PROVIDERS: readonly string[] = ["telegram", "max", "whatsapp"]

/**
 * The E.164 number a stored phone column stands for. A number written with `+` or `00` is read however it is spaced;
 * a `phone` identity keeps it whole. Bare digits are international only from a messenger that stores them so; from a
 * CRM or a card they are a national number, whose country nothing names, so they match nothing.
 */
export const storedPhone = (raw: string, provider: string): string | undefined => {
  if (/^\s*(\+|00)/.test(raw)) return typedPhone(raw)?.value
  if (!BARE_INTERNATIONAL_PROVIDERS.includes(provider)) return undefined
  const found = /^([1-9]\d{6,14})$/.exec(raw.trim())
  return found ? `+${found[1]}` : undefined
}
