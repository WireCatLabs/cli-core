import { disposableEmailBlocklistSet } from "disposable-email-domains-js"
import { getDomainWithoutSuffix } from "tldts"
import { isReadable } from "../../domain/display-names.js"
import { isCompanyName } from "../../domain/person-kinds.js"
import { FREE_MAIL, registrableOf } from "../../mail/score.js"
import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import { actorOfOrigin } from "./actors.js"
import { linkKind } from "./link-kinds.js"

/**
 * Newsletter hosts and mail services that send for many customers. Their domain names none of the senders, so it never
 * makes an organization; the bounce and signing domains are here for mail whose `From` carries them.
 */
export const SENDING_PLATFORMS: ReadonlySet<string> = new Set([
  "substack.com",
  "beehiiv.com",
  "ghost.io",
  "buttondown.email",
  "buttondown.com",
  "mailchimpapp.net",
  "mcsv.net",
  "mcdlv.net",
  "rsgsv.net",
  "list-manage.com",
  "mandrillapp.com",
  "sendgrid.net",
  "amazonses.com",
  "mailgun.org",
  "mailgun.net",
  "postmarkapp.com",
  "mtasv.net",
  "sparkpostmail.com",
  "convertkit-mail.com",
  "mlsend.com",
  "sendinblue.com",
  "brevosend.com",
])

/** How a rule's hold on an address is marked in `organization_identities.method`. */
export const BY_DOMAIN = "domain"
/** A rejected `proposed_actions` row of this kind keeps a rule from making an organization for its domain again. */
export const REFUSED_DOMAIN = "organization-domain"

let disposable: Set<string> | undefined
// `isDisposableEmailDomain` builds the whole set on every call: about 0.5 ms an address.
const isDisposable = (domain: string): boolean => {
  disposable ??= disposableEmailBlocklistSet()
  return disposable.has(domain)
}

/** The registrable domain whose organization an address joins; none for free, throwaway and platform mail. */
export const companyDomainOf = (address: string): string | undefined => {
  if (!address.includes("@")) return undefined
  const domain = registrableOf(address)
  return domain.includes(".") && !FREE_MAIL.has(domain) && !SENDING_PLATFORMS.has(domain) && !isDisposable(domain)
    ? domain
    : undefined
}

/**
 * A person as the kind pass leaves them: `holds` for a bot or a shared mailbox, whose addresses the organization owns;
 * never for one the owner kept as a person.
 */
export interface Sorted {
  id: number
  displayName: string | null
  holds: boolean
}

const nameFor = (shown: string | null, domain: string): string => {
  const label = getDomainWithoutSuffix(domain)
  return shown !== null &&
    isReadable(shown) &&
    (isCompanyName(shown) || (label !== null && fold(shown).trim() === fold(label)))
    ? shown.trim()
    : domain
}

const mailOf = (database: CacheDatabase, people: readonly number[]) => {
  const found = new Map<number, { identity: number; domain: string }[]>()
  for (const row of database
    .prepare(
      "SELECT l.person_id AS person, i.id, lower(i.external_id) AS address FROM identity_links l " +
        "JOIN identities i ON i.id = l.identity_id WHERE i.provider = 'email' " +
        "AND l.person_id IN (SELECT value FROM json_each(?)) ORDER BY i.id",
    )
    .all(JSON.stringify(people))) {
    const domain = companyDomainOf(String(row.address))
    if (domain === undefined) continue
    const person = Number(row.person)
    found.set(person, [...(found.get(person) ?? []), { identity: Number(row.id), domain }])
  }
  return found
}

/** Every organization by the company domains of the addresses it holds, and which identities are held at all. */
const holdersOf = (database: CacheDatabase) => {
  const byDomain = new Map<string, Set<number>>()
  const held = new Map<number, number>()
  for (const row of database
    .prepare(
      "SELECT oi.identity_id, oi.organization_id, lower(i.external_id) AS address FROM organization_identities oi " +
        "JOIN organizations o ON o.id = oi.organization_id JOIN identities i ON i.id = oi.identity_id " +
        "WHERE o.deleted_at IS NULL AND i.provider = 'email' ORDER BY oi.id",
    )
    .all()) {
    const organization = Number(row.organization_id)
    if (!held.has(Number(row.identity_id))) held.set(Number(row.identity_id), organization)
    const domain = companyDomainOf(String(row.address))
    if (domain !== undefined) byDomain.set(domain, (byDomain.get(domain) ?? new Set()).add(organization))
  }
  return { byDomain, held }
}

const refusedDomains = (database: CacheDatabase): Set<string> =>
  new Set(
    database
      .prepare(
        "SELECT json_extract(payload, '$.domain') AS domain FROM proposed_actions WHERE kind = ? AND status = 'rejected'",
      )
      .all(REFUSED_DOMAIN)
      .map((row) => String(row.domain)),
  )

/** Person → organization pairs the owner removed: a rule never links them again. */
const removedMemberships = (database: CacheDatabase): Set<string> =>
  new Set(
    database
      .prepare(
        "SELECT target_id, json_extract(payload, '$.to') AS target FROM proposed_actions WHERE kind = 'relationship' " +
          "AND status = 'rejected' AND target_type = 'person' AND json_extract(payload, '$.kind') = 'member-of' " +
          "AND json_extract(payload, '$.to') LIKE 'organization:%'",
      )
      .all()
      .map((row) => `${row.target_id}>${row.target}`),
  )

/** Humans the kind pass did not see who write from one of `domains`: a new organization takes them as members too. */
const othersAt = (database: CacheDatabase, domains: ReadonlySet<string>, seen: ReadonlySet<number>) => {
  const found = new Map<number, { identity: number; domain: string }[]>()
  for (const row of database
    .prepare(
      "SELECT l.person_id AS person, i.id, lower(i.external_id) AS address FROM identity_links l " +
        "JOIN identities i ON i.id = l.identity_id JOIN persons p ON p.id = l.person_id " +
        "WHERE i.provider = 'email' AND p.owner = 0 AND p.kind IS NOT NULL AND p.kind NOT IN ('test', 'merged') " +
        "AND NOT EXISTS (SELECT 1 FROM sender_bots b WHERE b.person_id = p.id) " +
        "AND NOT EXISTS (SELECT 1 FROM organization_identities oi WHERE oi.identity_id = i.id) ORDER BY i.id",
    )
    .all()) {
    const person = Number(row.person)
    if (seen.has(person)) continue
    const domain = companyDomainOf(String(row.address))
    if (domain === undefined || !domains.has(domain)) continue
    found.set(person, [...(found.get(person) ?? []), { identity: Number(row.id), domain }])
  }
  return found
}

/**
 * Plan step 5: a bot or a shared mailbox at a company domain joins that domain's organization, made when none holds
 * it; a human there becomes a `member-of` it, never merged. Free mail, throwaway mail and sending platforms make none.
 * The owner's word holds: a membership the owner removed and a domain whose organization the owner erased are not made
 * again. The caller holds the write lock.
 */
export const groupByDomain = (database: CacheDatabase, people: readonly Sorted[], at: number): void => {
  const mail = mailOf(
    database,
    people.map(({ id }) => id),
  )
  if (mail.size === 0) return
  const { byDomain, held } = holdersOf(database)
  const refused = refusedDomains(database)
  const created = new Set<string>()
  const create = database.prepare(
    "INSERT INTO organizations (kind, name, scope, created_at, updated_at) VALUES ('company', ?, 'personal', ?, ?) " +
      "RETURNING id",
  )
  const hold = database.prepare(
    "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
      `VALUES (?, ?, '${BY_DOMAIN}', 'rules', ?, ?) ON CONFLICT (identity_id, organization_id) DO NOTHING`,
  )
  const sends = database.prepare(
    "UPDATE sender_bots SET organization_id = ?, updated_at = ? WHERE person_id = ? AND organization_id IS NULL",
  )
  const holder = (domain: string): number | undefined => {
    const found = byDomain.get(domain)
    return found?.size === 1 ? [...found][0] : undefined
  }
  for (const person of people) {
    if (!person.holds) continue
    for (const { identity, domain } of mail.get(person.id) ?? []) {
      let organization = held.get(identity)
      if (organization === undefined) {
        if ((byDomain.get(domain)?.size ?? 0) > 1) continue
        organization = holder(domain)
        if (organization === undefined) {
          if (refused.has(domain)) continue
          organization = Number(create.get(nameFor(person.displayName, domain), at, at)?.id)
          byDomain.set(domain, new Set([organization]))
          created.add(domain)
        }
        hold.run(identity, organization, at, at)
        held.set(identity, organization)
      }
      sends.run(organization, at, person.id)
    }
  }
  const removed = removedMemberships(database)
  const member = database.prepare(
    "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, author, evidence, metadata, " +
      `created_at, updated_at) SELECT 'person', ?, 'organization', ?, ${linkKind("member-of")}, 'owner', 1, 'rule', ?, ` +
      `'{"derived":"mail-domain"}', ?, ? ` +
      "WHERE NOT EXISTS (SELECT 1 FROM links WHERE from_type = 'person' AND from_id = ? AND to_type = 'organization' " +
      `AND to_id = ? AND kind = ${linkKind("member-of")})`,
  )
  const join = (person: number, addresses: { identity: number; domain: string }[]) => {
    for (const domain of new Set(addresses.map((one) => one.domain))) {
      const organization = holder(domain)
      if (organization === undefined || removed.has(`${person}>organization:${organization}`)) continue
      member.run(person, organization, `writes from ${domain}`, at, at, person, organization)
    }
  }
  const seen = new Set(people.map(({ id }) => id))
  for (const person of people) if (!person.holds) join(person.id, mail.get(person.id) ?? [])
  if (created.size > 0) for (const [person, addresses] of othersAt(database, created, seen)) join(person, addresses)
}

/** The owner erased an organization: no rule makes one for the company domains it held again. */
export const refuseDomainsOf = (database: CacheDatabase, organization: number, at: number): void => {
  const domains = new Set(
    database
      .prepare(
        "SELECT lower(i.external_id) AS address FROM organization_identities oi JOIN identities i ON i.id = oi.identity_id " +
          "WHERE oi.organization_id = ? AND i.provider = 'email'",
      )
      .all(organization)
      .flatMap((row) => companyDomainOf(String(row.address)) ?? []),
  )
  if (domains.size === 0) return
  const rule = actorOfOrigin(database, "rule")
  const owner = database.prepare("SELECT id FROM persons WHERE owner = 1 ORDER BY id LIMIT 1").get()
  const refuse = database.prepare(
    "INSERT INTO proposed_actions (kind, payload, reason, status, proposed_by_type, proposed_by_id, decided_by_type, " +
      "decided_by_id, decided_at, created_at, updated_at) VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?)",
  )
  const already = refusedDomains(database)
  for (const domain of [...domains].filter((one) => !already.has(one)))
    refuse.run(
      REFUSED_DOMAIN,
      JSON.stringify({ domain }),
      `the owner erased organization:${organization}`,
      rule.type,
      rule.id,
      owner === undefined ? null : "person",
      owner === undefined ? null : Number(owner.id),
      owner === undefined ? null : at,
      at,
      at,
    )
}

/** The owner moved these identities to a person: the holds a rule gave them go, so they read as a person's again. */
export const releaseDomainHolds = (database: CacheDatabase, identities: readonly number[]): void => {
  database
    .prepare(
      `DELETE FROM organization_identities WHERE method = '${BY_DOMAIN}' AND author = 'rules' ` +
        "AND identity_id IN (SELECT value FROM json_each(?))",
    )
    .run(JSON.stringify(identities))
}
