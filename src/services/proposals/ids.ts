import { CliError } from "@wirecat/cli-base"

const MAX_IDS = 500

const refuse = (message: string): never => {
  throw new CliError("validation_error", message, { reason: "proposal.ids" })
}

const range = (prefix: string, from: string, to: string): string[] => {
  const [start, end] = [Number(from), Number(to)]
  if (start > end) return refuse(`a range runs upwards: ${from}-${to}`)
  if (end - start + 1 > MAX_IDS) return refuse(`a range takes at most ${MAX_IDS} ids`)
  return Array.from({ length: end - start + 1 }, (_, n) => `${prefix}${start + n}`)
}

const one = (token: string): string[] => {
  const bare = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(token)
  if (bare?.[1]) return bare[2] ? range("", bare[1], bare[2]) : [bare[1]]
  const part = /^([1-9]\d*)\/([A-Za-z0-9_-]{1,64})$/.exec(token)
  if (part) return [token]
  const prefixed = /^([a-z][a-z_]*):([1-9]\d*)(?:-(?:([a-z][a-z_]*):)?([1-9]\d*))?$/.exec(token)
  if (prefixed?.[1] && prefixed[2]) {
    const [, prefix, from, other, to] = prefixed
    if (other !== undefined && other !== prefix) return refuse(`a range stays inside one prefix: ${token}`)
    return to ? range(`${prefix}:`, from, to) : [`${prefix}:${from}`]
  }
  if (/^[1-9]\d*-[a-z]/.test(token)) return refuse(`a range stays inside one prefix: ${token}`)
  return refuse(`not a proposal id: ${token}; use 17070, 17070-17079, fact:512 or 17080/f2`)
}

/**
 * Proposal ids from the command line, before any reference parsing: `17070-17079,fact:500-502,17080/f1` becomes
 * each id once, in the order given.
 */
export const parseProposalIds = (text: readonly string[]): string[] => {
  const ids = [...new Set(text.flatMap((arg) => arg.split(",")).flatMap((token) => one(token.trim())))]
  if (ids.length === 0) return refuse("name at least one proposal id")
  if (ids.length > MAX_IDS) return refuse(`decide at most ${MAX_IDS} proposals at once`)
  return ids
}
