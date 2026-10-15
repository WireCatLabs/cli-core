import { randomBytes } from "node:crypto"

// biome-ignore lint/security/noSecrets: Crockford base32 alphabet, not a key
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** 26 characters, sortable by creation time: 48 bits of milliseconds, then 80 random bits. */
export const ulid = (now: number = Date.now()): string => {
  let time = ""
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time
  let random = ""
  for (const byte of randomBytes(16)) random += CROCKFORD[byte % 32]
  return time + random
}
