/**
 * What generated Valibot schemas call at run time. Kept apart from the generator so a CLI loads
 * these few functions, not the code that writes code.
 *
 * Numbers arrive from a lossless JSON parser (`lossless-json` or anything shaped like its
 * `LosslessNumber`), because a 64-bit id read as a JS number is silently a different id.
 */
import * as v from "valibot"

interface LosslessLike {
  isLosslessNumber: true
  value: string
}

const isLossless = (input: unknown): input is LosslessLike =>
  typeof input === "object" &&
  input !== null &&
  (input as { isLosslessNumber?: unknown }).isLosslessNumber === true &&
  typeof (input as { value?: unknown }).value === "string"

const INTEGER = /^-?\d+$/
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

const digitsOf = (input: unknown): string | undefined => {
  if (isLossless(input)) return INTEGER.test(input.value) ? input.value : undefined
  if (typeof input === "bigint") return input.toString()
  if (typeof input === "number" && Number.isSafeInteger(input)) return String(input)
  return undefined
}

interface Range {
  minimum?: number
  maximum?: number
}

const inRange = (value: number | bigint, { minimum, maximum }: Range): boolean =>
  (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum)

/** A 64-bit integer, handed on as its exact decimal string. */
export const int64 = (range: Range = {}) =>
  v.pipe(
    v.custom<LosslessLike | bigint | number>((input) => digitsOf(input) !== undefined, "expected an integer"),
    v.transform((input) => digitsOf(input) as string),
    v.check((digits) => {
      const value = BigInt(digits)
      return value >= INT64_MIN && value <= INT64_MAX && inRange(value, range)
    }, "integer out of range"),
  )

/** An integer that must fit a JS number exactly; one that does not fails instead of rounding. */
export const integer = (range: Range = {}) =>
  v.pipe(
    v.custom<LosslessLike | bigint | number>((input) => {
      const digits = digitsOf(input)
      return digits !== undefined && Number.isSafeInteger(Number(digits))
    }, "expected an integer within ±2^53"),
    v.transform((input) => Number(digitsOf(input))),
    v.check((value) => inRange(value, range), "integer out of range"),
  )

export const number = (range: Range = {}) =>
  v.pipe(
    v.custom<LosslessLike | number>(
      (input) => (isLossless(input) ? Number.isFinite(Number(input.value)) : Number.isFinite(input)),
      "expected a number",
    ),
    v.transform((input) => (isLossless(input) ? Number(input.value) : (input as number))),
    v.check((value) => inRange(value, range), "number out of range"),
  )

export const unique = (items: readonly unknown[]): boolean =>
  new Set(items.map((item) => JSON.stringify(item))).size === items.length
