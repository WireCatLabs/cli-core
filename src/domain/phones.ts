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
