import { getDomain } from "tldts"
import { expect, it } from "vitest"
import { SECTOR_DOMAINS } from "./organization-sectors.generated.js"
import { SECTORS } from "./organization-sectors.js"

const all = SECTORS.flatMap((sector) => SECTOR_DOMAINS[sector].split(" "))

it("holds each registrable domain once, in lower case, as mail is read", () => {
  expect(new Set(all).size).toBe(all.length)
  expect(all.filter((domain) => getDomain(domain) !== domain || domain !== domain.toLowerCase())).toEqual([])
})
