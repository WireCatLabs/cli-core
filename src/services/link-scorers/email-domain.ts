import { contactRef } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const WEIGHT = 0.3
const CONTACTS = 500
const MOST_PAIRS = 200
const FREE = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
])

/**
 * People whose mail addresses share a company domain, related to each other, weakly: a shared domain does not prove
 * they work together. Needs no project; the rule `relationships scan` ran before scorers existed.
 */
export const emailDomain: LinkScorer = {
  id: "email-domain",
  version: 1,
  candidates: async ({ store, sources, owner, signal }) => {
    const domains = new Map<string, Map<string, string>>()
    for (const key of sources) {
      if (key.provider !== "email") continue
      signal?.throwIfAborted()
      const contacts = await store.people.contacts(key, { order: "name", limit: CONTACTS, offset: 0 })
      for (const contact of contacts.items) {
        const address = String(contact.id).toLowerCase()
        const domain = address.split("@")[1]
        if (!domain || FREE.has(domain)) continue
        const person = await store.people.personOf({ provider: key.provider, id: contact.id })
        if (!person || `person:${person.uid}` === owner) continue
        const people = domains.get(domain) ?? new Map<string, string>()
        if (!people.has(`person:${person.uid}`))
          people.set(`person:${person.uid}`, contactRef(key.provider, contact.id))
        domains.set(domain, people)
      }
    }
    const found: LinkCandidate[] = []
    for (const [domain, people] of domains) {
      const sorted = [...people].sort(([a], [b]) => a.localeCompare(b))
      for (let left = 0; left < sorted.length; left++)
        for (let right = left + 1; right < sorted.length; right++) {
          if (found.length >= MOST_PAIRS) return found
          const [from, identity] = sorted[left] as [string, string]
          const [to] = sorted[right] as [string, string]
          found.push({
            from,
            to,
            kind: "related-to",
            weight: WEIGHT,
            why: `addresses share the domain ${domain}; this does not prove they work together`,
            evidence: [],
            identity,
          })
        }
    }
    return found
  },
}
