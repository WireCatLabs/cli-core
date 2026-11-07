import { CliError } from "@wirecat/cli-base"

/**
 * Minor-unit digits per ISO 4217 for the currencies the store keeps money in. A currency outside the list is refused
 * rather than guessed: a wrong scale would store every amount 100 times off.
 */
export const CURRENCY_SCALES: Readonly<Record<string, number>> = {
  AED: 2,
  AMD: 2,
  AUD: 2,
  BHD: 3,
  BYN: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  GEL: 2,
  HUF: 2,
  ILS: 2,
  INR: 2,
  ISK: 0,
  JPY: 0,
  KGS: 2,
  KRW: 0,
  KWD: 3,
  KZT: 2,
  NOK: 2,
  PLN: 2,
  RSD: 2,
  RUB: 2,
  SEK: 2,
  THB: 2,
  TRY: 2,
  UAH: 2,
  USD: 2,
  UZS: 2,
  VND: 0,
}

/** An exact amount as callers read and write it: a decimal string with the currency's scale, never a float. */
export interface Money {
  amount: string
  currency: string
}

const refuse = (message: string, reason: string): never => {
  throw new CliError("validation_error", message, { reason })
}

const DECIMAL = /^(\d{1,15})(?:\.(\d+))?$/

/** A non-negative decimal as an integer of `scale` decimal places; `undefined` when it is not one. */
export const parseDecimal = (text: string, scale: number): bigint | undefined => {
  const match = DECIMAL.exec(text.trim())
  if (!match || (match[2] ?? "").length > scale) return undefined
  return BigInt(`${match[1]}${(match[2] ?? "").padEnd(scale, "0")}`)
}

export const formatDecimal = (units: bigint | number, scale: number): string => {
  const value = BigInt(units)
  if (value < 0n) return `-${formatDecimal(-value, scale)}`
  const digits = value.toString().padStart(scale + 1, "0")
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

/** `50000.00` as `50 000.00`: groups of three in the whole part, as a list prints an amount. */
export const groupDigits = (decimal: string): string => {
  const [whole = "0", fraction] = decimal.split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

export const currencyOf = (text: unknown): string => {
  const code = typeof text === "string" ? text.trim().toUpperCase() : ""
  if (CURRENCY_SCALES[code] === undefined)
    return refuse(
      `${typeof text === "string" && text.trim() ? text.trim() : "an empty currency"} is not a currency the store keeps; ` +
        `use one of ${Object.keys(CURRENCY_SCALES).join(", ")}`,
      "money.currency",
    )
  return code
}

export const scaleOf = (currency: string): number => CURRENCY_SCALES[currencyOf(currency)] as number

/** Minor units of `currency` for a decimal string such as "50000.00"; refuses more decimals than the currency has. */
export const minorUnits = (amount: unknown, currency: string, what = "an amount"): number => {
  const scale = scaleOf(currency)
  const units = typeof amount === "string" ? parseDecimal(amount, scale) : undefined
  if (units === undefined || units > BigInt(Number.MAX_SAFE_INTEGER))
    return refuse(
      `${what} is a decimal string with at most ${scale} decimal${scale === 1 ? "" : "s"} for ${currency}, ` +
        `such as "${formatDecimal(5_000 * 10 ** scale, scale)}"`,
      "money.amount",
    )
  return Number(units)
}

/** Minor units for a decimal that may be negative, such as an opening balance of "-1200.50". */
export const signedMinorUnits = (amount: unknown, currency: string, what = "an amount"): number => {
  if (typeof amount !== "string" || !amount.trim().startsWith("-")) return minorUnits(amount, currency, what)
  const units = minorUnits(amount.trim().slice(1), currency, what)
  return units === 0 ? 0 : -units
}

export const moneyOf = (units: number, currency: string): Money => ({
  amount: formatDecimal(units, scaleOf(currency)),
  currency,
})

/** "50 000.00 RUB". */
export const moneyLabel = (units: number, currency: string): string =>
  `${groupDigits(formatDecimal(units, scaleOf(currency)))} ${currency}`

const QUANTITY_SCALE = 3

/** A quantity such as "1.5" (hours, days), kept as text: at most 3 decimals, more than 0. */
export const quantityOf = (text: unknown): { text: string; thousandths: bigint } => {
  const thousandths = typeof text === "string" ? parseDecimal(text, QUANTITY_SCALE) : undefined
  if (thousandths === undefined || thousandths === 0n)
    return refuse('a quantity is a decimal string above 0 with at most 3 decimals, such as "1.5"', "money.quantity")
  const plain = formatDecimal(thousandths, QUANTITY_SCALE).replace(/\.?0+$/, "")
  return { text: plain, thousandths }
}

/** Quantity times unit price in minor units, half rounded up. */
export const lineUnits = (thousandths: bigint, unitPrice: number): number =>
  Number((thousandths * BigInt(unitPrice) + 500n) / 1000n)
