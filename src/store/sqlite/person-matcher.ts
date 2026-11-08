export { e164Of, storedPhone } from "../../domain/phones.js"

import type { CacheDatabase } from "../driver.js"

/** The spellings of an E.164 number `storedPhone` reads back as it. */
const spellingsOf = (value: string): [string, string] => [value, value.slice(1)]

const PERSON_BY = {
  // UNION, not OR: each branch reads its own index.
  email:
    "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
    "WHERE i.provider = 'email' AND i.external_id = ? UNION " +
    "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id WHERE i.email = ?",
  phone:
    "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
    "WHERE i.provider = 'phone' AND i.external_id = ? UNION " +
    "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id WHERE i.phone IN (?, ?)",
  contact:
    "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
    "WHERE i.provider = ? AND i.external_id = ?",
}

/** What a person is matched by: lower-cased addresses, E.164 numbers and a source's own contact identity. */
export interface PersonIdentifiers {
  emails: readonly string[]
  phones: readonly string[]
  contact?: { provider: string; externalId: string } | undefined
}

/**
 * The people the identifiers point at, each once, by id. The one lookup the records import and the people matcher
 * share; it reads the store and nothing else.
 */
export const personsByIdentifiers = (database: CacheDatabase, ids: PersonIdentifiers): number[] => {
  const found = new Set<number>()
  const add = (rows: Record<string, unknown>[]) => {
    for (const row of rows) found.add(Number(row.person_id))
  }
  for (const email of ids.emails) add(database.prepare(PERSON_BY.email).all(email, email))
  for (const value of ids.phones) add(database.prepare(PERSON_BY.phone).all(value, ...spellingsOf(value)))
  if (ids.contact) add(database.prepare(PERSON_BY.contact).all(ids.contact.provider, ids.contact.externalId))
  return [...found].sort((a, b) => a - b)
}
