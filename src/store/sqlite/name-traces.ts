import { isEmailAddress, isNoReplyAddress, isRoleAddress } from "../../domain/addresses.js"
import { displayName } from "../../domain/display-names.js"
import { variantKey } from "../../domain/name-variants.js"
import { storedPhone } from "../../domain/phones.js"
import { FREE_MAIL } from "../../mail/score.js"
import type { CacheDatabase } from "../driver.js"
import { referenceOfThing } from "./things.js"

/**
 * People, owner aside, by the name they share once case, quotes, word order, script and spelling are set aside:
 * `Светлана Кузнецова` and `Svetlana Kuznetsova` are one name here (BUG-678).
 */
export const peopleByNameKey = (database: CacheDatabase): Map<string, { people: number[]; name: string }> => {
  const found = new Map<string, { people: number[]; name: string }>()
  for (const row of database
    .prepare(
      "SELECT p.id, p.name FROM persons p WHERE p.owner = 0 AND p.name IS NOT NULL " +
        "AND EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = p.id) ORDER BY p.id",
    )
    .all()) {
    const name = String(row.name)
    const key = variantKey(name)
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
  kind: "chat" | "email" | "crm-company" | "email-domain" | "phone"
  /** The phone or address, for the kinds that have one. */
  value?: string
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

const tracesOf = (database: CacheDatabase, person: number, except?: string): Traces => {
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
      if (address === undefined || address === except) continue
      traces.emails.push({ identity, value: address })
      const domain = companyDomain(address)
      if (domain !== undefined) traces.domains.push({ identity, value: domain })
    }
  }
  return traces
}

function* common(a: Held[], b: Held[]): Generator<[Held, Held]> {
  const seen = new Set<string>()
  for (const one of a) {
    const other = b.find(({ value }) => value === one.value)
    if (other === undefined || seen.has(one.value)) continue
    seen.add(one.value)
    yield [one, other]
  }
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

/** An organization the CRM puts both people in, with a CRM identity of each: the owner's CRM, not a mail domain. */
const crmCompany = (database: CacheDatabase, a: number, b: number) => {
  const row = database
    .prepare(
      "SELECT k1.to_id AS organization, (SELECT min(identity_id) FROM identity_links WHERE person_id = ?) AS one, " +
        "(SELECT min(identity_id) FROM identity_links WHERE person_id = ?) AS other FROM links k1 " +
        "JOIN links k2 ON k2.to_type = 'organization' AND k2.to_id = k1.to_id AND k2.kind = 'member-of' " +
        "AND k2.source = 'crm' AND k2.deleted_at IS NULL AND k2.from_type = 'person' AND k2.from_id = ? " +
        "WHERE k1.from_type = 'person' AND k1.from_id = ? AND k1.to_type = 'organization' AND k1.kind = 'member-of' " +
        "AND k1.source = 'crm' AND k1.deleted_at IS NULL ORDER BY k1.to_id LIMIT 1",
    )
    .get(a, b, b, a)
  if (!row || row.one == null || row.other == null) return undefined
  return {
    one: row.one,
    other: row.other,
    ref: referenceOfThing(database, { type: "organization", id: Number(row.organization) }),
  }
}

/**
 * The traces two people share, strongest first: each phone, each address, a chat, one company in the CRM, a company's
 * domain. `except` is an address left out, with its domain, when it is the very thing being weighed.
 */
export function* sharedTraces(
  database: CacheDatabase,
  a: number,
  b: number,
  name: string,
  except?: string,
): Generator<SharedTrace> {
  const [one, other] = [tracesOf(database, a, except), tracesOf(database, b, except)]
  for (const phone of common(one.phones, other.phones))
    yield {
      identity: phone[0].identity,
      with: phone[1].identity,
      kind: "phone",
      value: phone[0].value,
      evidence: [],
      reason: `same name «${name}» and the same phone`,
    }
  for (const email of common(one.emails, other.emails))
    yield {
      identity: email[0].identity,
      with: email[1].identity,
      kind: "email",
      value: email[0].value,
      evidence: [],
      reason: `same name «${name}» and the same address ${email[0].value}`,
    }
  const chat = commonChat(database, a, b)
  if (chat) {
    const ref = referenceOfThing(database, { type: "chat", id: Number(chat.chat_id) })
    yield {
      identity: Number(chat.one),
      with: Number(chat.other),
      kind: "chat",
      evidence: ref === undefined ? [] : [ref],
      reason: `same name «${name}» and a chat they are both in`,
    }
  }
  const company = crmCompany(database, a, b)
  if (company)
    yield {
      identity: Number(company.one),
      with: Number(company.other),
      kind: "crm-company",
      evidence: company.ref === undefined ? [] : [company.ref],
      reason: `same name «${name}» and the same company in the CRM`,
    }
  const domain = common(one.domains, other.domains).next().value
  if (domain)
    yield {
      identity: domain[0].identity,
      with: domain[1].identity,
      kind: "email-domain",
      evidence: [],
      reason: `same name «${name}» and mail at the same company, ${domain[0].value}`,
    }
}
