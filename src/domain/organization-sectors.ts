import { FREE_MAIL_DOMAINS } from "./free-mail-domains.generated.js"
import { SECTOR_DOMAINS } from "./organization-sectors.generated.js"

/** Sectors only the domain-list pack gives (`domain-lists update`): UT1 has them, Wikidata's table does not. */
export const PACK_SECTORS = ["gaming_gambling", "adult", "freemail"] as const

/**
 * What an organization does (a bank, an airline, a shop), from the websites Wikidata lists, built into the package by
 * `scripts/organization-sectors.ts`, and from the domain-list pack. Apart from `Category`, which says what an
 * organization is to the owner.
 */
export type Sector = keyof typeof SECTOR_DOMAINS | (typeof PACK_SECTORS)[number]
/** Most specific first: an organization holding domains of two sectors takes the first. */
export const SECTORS = [
  ...(Object.keys(SECTOR_DOMAINS) as (keyof typeof SECTOR_DOMAINS)[]),
  ...PACK_SECTORS,
] as Sector[]

export const isSector = (value: string): value is Sector => (SECTORS as string[]).includes(value)

let sectors: Map<string, Sector> | undefined

/** The sector of a registrable domain from the built-in table, lower case as `registrableOf` gives it. */
export const sectorOfDomain = (domain: string): Sector | undefined => {
  sectors ??= new Map(
    Object.entries(SECTOR_DOMAINS).flatMap(([sector, domains]) =>
      domains.split(" ").map((one): [string, Sector] => [one, sector as Sector]),
    ),
  )
  return sectors.get(domain)
}

let freeMail: Set<string> | undefined

/** A mailbox provider anyone can sign up to (microlink's MIT list, built in): its domain names no organization. */
export const isFreeMailDomain = (domain: string): boolean => {
  freeMail ??= new Set(FREE_MAIL_DOMAINS.split(" "))
  return freeMail.has(domain)
}
