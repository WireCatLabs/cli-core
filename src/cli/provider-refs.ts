const HIDDEN = new Set(["providerRef", "provider_ref"])

/**
 * The value with every `providerRef` taken out, at any depth. An adapter keeps there what it needs to fetch a file
 * again — WhatsApp's media path and decryption keys, a MAX bot's token — so it never leaves the process (SEC-54).
 */
export const withoutProviderRefs = <T>(value: T): T => strip(value) as T

const strip = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strip)
  if (value === null || typeof value !== "object") return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inner]) => (HIDDEN.has(key) ? [] : [[key, strip(inner)]])),
  )
}
