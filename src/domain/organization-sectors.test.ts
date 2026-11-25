import { getDomain } from "tldts"
import { expect, it } from "vitest"
import { FREE_MAIL_DOMAINS } from "./free-mail-domains.generated.js"
import { SECTOR_DOMAINS } from "./organization-sectors.generated.js"
import { isFreeMailDomain, sectorOfDomain } from "./organization-sectors.js"

const all = Object.values(SECTOR_DOMAINS).flatMap((domains) => domains.split(" "))

it("holds each registrable domain once, in lower case, as mail is read", () => {
  expect(new Set(all).size).toBe(all.length)
  expect(all.filter((domain) => getDomain(domain) !== domain || domain !== domain.toLowerCase())).toEqual([])
})

it("leaves a provider that is also a Wikidata organization to its sector, not to free mail", () => {
  const free = FREE_MAIL_DOMAINS.split(" ")
  expect(free.filter((domain) => sectorOfDomain(domain) !== undefined)).toEqual([])
  expect(free.filter((domain) => getDomain(domain) !== domain)).toEqual([])
  expect([isFreeMailDomain("seznam.cz"), isFreeMailDomain("sky.com"), sectorOfDomain("sky.com")]).toEqual([
    true,
    false,
    "telecom",
  ])
})
