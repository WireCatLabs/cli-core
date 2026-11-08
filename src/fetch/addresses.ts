import { isIP } from "node:net"

type Prefix = readonly [bytes: readonly number[], bits: number]

const within = (address: Uint8Array, [prefix, bits]: Prefix): boolean => {
  for (let bit = 0; bit < bits; bit++) {
    const mask = 0x80 >> (bit % 8)
    if (((address[bit >> 3] ?? 0) & mask) !== ((prefix[bit >> 3] ?? 0) & mask)) return false
  }
  return true
}

/** Not the public internet (RFC 6890 and its updates); 240/4 holds the broadcast address. */
const V4_PRIVATE: readonly Prefix[] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 88, 99], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 4],
  [[240], 4],
]

/** Inside global unicast (2000::/3), the blocks that are not the public internet. */
const V6_PRIVATE: readonly Prefix[] = [
  [[0x20, 0x01, 0x00, 0x00], 23],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x3f, 0xff], 20],
]

/** Forms that carry an IPv4 address, and where it sits: mapped, NAT64 and 6to4. */
const V6_CARRIERS: readonly (readonly [Prefix, number])[] = [
  [[[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96], 12],
  [[[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96], 12],
  [[[0x20, 0x02], 16], 2],
]

const v4Bytes = (text: string): Uint8Array => new Uint8Array(text.split(".").map(Number))

const v6Bytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(16)
  let address = text.replace(/%.*$/, "")
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (dotted?.[1]) {
    const [a, b, c, d] = v4Bytes(dotted[1])
    address = `${address.slice(0, dotted.index)}${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`
  }
  const [head = "", tail] = address.split("::")
  const groups = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [])
  const left = groups(head)
  const right = tail === undefined ? [] : groups(tail)
  const all = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
  all.forEach((group, at) => {
    bytes[at * 2] = group >> 8
    bytes[at * 2 + 1] = group & 0xff
  })
  return bytes
}

const publicV4 = (bytes: Uint8Array) => !V4_PRIVATE.some((prefix) => within(bytes, prefix))

/**
 * Whether an IP address is on the public internet: not loopback, private, link-local, CGNAT, ULA, multicast,
 * unspecified, documentation or reserved, nor one of those carried in an IPv6 form (`::ffff:10.0.0.1`).
 */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) return publicV4(v4Bytes(address))
  if (family !== 6) return false
  const bytes = v6Bytes(address)
  for (const [prefix, at] of V6_CARRIERS) if (within(bytes, prefix)) return publicV4(bytes.subarray(at, at + 4))
  return within(bytes, [[0x20], 3]) && !V6_PRIVATE.some((prefix) => within(bytes, prefix))
}
