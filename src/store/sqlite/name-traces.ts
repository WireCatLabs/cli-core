import { isEmailAddress, isNoReplyAddress, isRoleAddress } from "../../domain/addresses.js"
import { displayName, nameKey } from "../../domain/display-names.js"
import { storedPhone } from "../../domain/phones.js"
import { FREE_MAIL } from "../../mail/score.js"
import type { CacheDatabase } from "../driver.js"
import { referenceOfThing } from "./things.js"

/** People, owner aside, by the name they share once case, quotes and word order are set aside. */
export const peopleByNameKey = (database: CacheDatabase): Map<string, { people: number[]; name: string }> => {
  const found = new Map<string, { people: number[]; name: string }>()
  for (const row of database
    .prepare(
      "SELECT p.id, p.name FROM persons p WHERE p.owner = 0 AND p.name IS NOT NULL " +
        "AND EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = p.id) ORDER BY p.id",
    )
    .all()) {
    const name = String(row.name)
    const key = nameKey(name)
    if (key === null) continue
    const held = found.get(key) ?? { people: [], name: displayName(name) ?? name }
    held.people.push(Number(row.id))
    found.set(key, held)
  }
  return found
}

/** What two people with one name share: the proof that they may be one, named to the owner. */
export interface SharedTrace {
  /** An identity of each side that holds it. */
  identity: number
  with: number
  kind: "chat" | "email" | "email-domain" | "phone"
  evidence: string[]
  reason: string
}

interface Held {
  identity: number
  value: string
}

interface Traces {
  phones: Held[]
  emails: Held[]
  domains: Held[]
}

const addressOf = (value: unknown): string | undefined => {
  const address = typeof value === "string" ? value.trim().toLowerCase() : ""
  return isEmailAddress(address) && !isNoReplyAddress(address) ? address : undefined
}

/** A company's domain: not a free mailbox such as gmail.com, and not from a role address such as `info@`. */
const companyDomain = (address: string): string | undefined => {
  const domain = address.split("@")[1]
  return domain === undefined || FREE_MAIL.has(domain) || isRoleAddress(address) ? undefined : domain
}

const tracesOf = (database: CacheDatabase, person: number): Traces => {
  const traces: Traces = { phones: [], emails: [], domains: [] }
  for (const row of database
    .prepare(
      "SELECT i.id, i.provider, i.external_id, i.phone, i.email FROM identity_links l " +
        "JOIN identities i ON i.id = l.identity_id WHERE l.person_id = ? AND i.provider <> 'org-email' ORDER BY i.id",
    )
    .all(person)) {
    const identity = Number(row.id)
    const provider = String(row.provider)
    const phone = provider === "phone" ? row.external_id : row.phone
    const stored = typeof phone === "string" ? storedPhone(phone, provider) : undefined
    if (stored !== undefined) traces.phones.push({ identity, value: stored })
    for (const address of [addressOf(row.email), provider === "email" ? addressOf(row.external_id) : undefined]) {
      if (address === undefined) continue
      traces.emails.push({ identity, value: address })
      const domain = companyDomain(address)
      if (domain !== undefined) traces.domains.push({ identity, value: domain })
    }
  }
  return traces
}

const common = (a: Held[], b: Held[]): [Held, Held] | undefined => {
  for (const one of a) {
    const other = b.find(({ value }) => value === one.value)
    if (other !== undefined) return [one, other]
  }
  return undefined
}

const commonChat = (database: CacheDatabase, a: number, b: number) =>
  database
    .prepare(
      "SELECT m1.chat_id, m1.identity_id AS one, m2.identity_id AS other FROM identity_links l1 " +
        "JOIN chat_members m1 ON m1.identity_id = l1.identity_id " +
        "JOIN chat_members m2 ON m2.chat_id = m1.chat_id " +
        "JOIN identity_links l2 ON l2.identity_id = m2.identity_id " +
        "WHERE l1.person_id = ? AND l2.person_id = ? ORDER BY m1.chat_id LIMIT 1",
    )
    .get(a, b)

/** The first trace two people share, strongest first: a phone, an address, a chat, a company's domain. */
export const sharedTrace = (database: CacheDatabase, a: number, b: number, name: string): SharedTrace | undefined => {
  const [one, other] = [tracesOf(database, a), tracesOf(database, b)]
  const phone = common(one.phones, other.phones)
  if (phone)
    return {
      identity: phone[0].identity,
      with: phone[1].identity,
      kind: "phone",
      evidence: [],
      reason: `same name «${name}» and the same phone`,
    }
  const email = common(one.emails, other.emails)
  if (email)
    return {
      identity: email[0].identity,
      with: email[1].identity,
      kind: "email",
      evidence: [],
      reason: `same name «${name}» and the same address ${email[0].value}`,
    }
  const chat = commonChat(database, a, b)
  if (chat) {
    const ref = referenceOfThing(database, { type: "chat", id: Number(chat.chat_id) })
    return {
      identity: Number(chat.one),
      with: Number(chat.other),
      kind: "chat",
      evidence: ref === undefined ? [] : [ref],
      reason: `same name «${name}» and a chat they are both in`,
    }
  }
  const domain = common(one.domains, other.domains)
  if (domain)
    return {
      identity: domain[0].identity,
      with: domain[1].identity,
      kind: "email-domain",
      evidence: [],
      reason: `same name «${name}» and mail at the same company, ${domain[0].value}`,
    }
  return undefined
}
