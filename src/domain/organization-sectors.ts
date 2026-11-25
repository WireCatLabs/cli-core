import { SECTOR_DOMAINS } from "./organization-sectors.generated.js"

/**
 * What an organization does (a bank, an airline, a shop), from the websites Wikidata lists, built into the package by
 * `scripts/organization-sectors.ts`. Apart from `Category`, which says what an organization is to the owner.
 */
export type Sector = keyof typeof SECTOR_DOMAINS
/** Most specific first: an organization holding domains of two sectors takes the first. */
export const SECTORS = Object.keys(SECTOR_DOMAINS) as Sector[]

let sectors: Map<string, Sector> | undefined

/** The sector of a registrable domain, lower case as `registrableOf` gives it. */
export const sectorOfDomain = (domain: string): Sector | undefined => {
  sectors ??= new Map(
    SECTORS.flatMap((sector) => SECTOR_DOMAINS[sector].split(" ").map((one): [string, Sector] => [one, sector])),
  )
  return sectors.get(domain)
}
