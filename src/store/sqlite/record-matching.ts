import { isEmailAddress } from "../../domain/addresses.js"
import { isObject } from "../../domain/record-fields.js"
import { type IdentityType, RECORD_TABLES } from "../../domain/record-types.js"
import type { EnvelopeOptions, EnvelopeSource } from "../../domain/records.js"
import { FREE_MAIL } from "../../mail/score.js"
import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import { crmIdentityId } from "./crm.js"
import { insertProject } from "./knowledge.js"
import type { StoreContext } from "./open.js"
import { e164Of, personsByIdentifiers } from "./person-matcher.js"
import { identitySeparated } from "./person-separation.js"
import { type Row, refusal } from "./record-projection.js"

/** The strong identifiers a person, organization or project record gives; a name is never one. */
export interface Identifiers {
  /** Lower-cased, as every writer of an e-mail identity keeps them. */
  emails: string[]
  /** E.164. */
  phones: string[]
  /** The source's own contact identity, `<account>/contact/<external id>` under its provider, as CRM sync writes it. */
  contact?: { provider: string; externalId: string }
  /** An organization's, by the identity provider its scheme is kept under. */
  organization: { provider: string; value: string }[]
  /** A project's key, upper-cased. */
  key?: string
  /** Values that look like an identifier but were not read as one, with why: a phone without `+` and no region. */
  ignored: { at: (string | number)[]; reason: "record.phone-region" }[]
}

export type Match =
  | { outcome: "none" }
  | { outcome: "one"; id: number }
  | { outcome: "ambiguous"; ids: number[]; reason: "record.ambiguous" | "record.separated" }

const valuesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((one): one is string => typeof one === "string")

const SCHEME = /^(email|domain|tax-id:[a-z]{2}|registration:[a-z]{2})$/

/**
 * Each scheme under a provider of its own: an organization's address is never a person's `email` identity, so a
 * company identifier can never take, or be taken for, a person's mail.
 */
const ORG_EMAIL = "org-email"
const providerOf = (scheme: string) => (scheme === "email" ? ORG_EMAIL : scheme)

const domainOf = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")

/**
 * A record's identifiers. What does not read as an e-mail, a phone or a `{scheme, value}` of a known scheme is no
 * identifier and stays in the fields, as v1 kept it; a free-mail domain claimed as an organization's is refused.
 */
export const identifiersOf = (
  type: IdentityType,
  fields: Row,
  source: EnvelopeSource,
  externalId: string,
  options: EnvelopeOptions = {},
): Identifiers => {
  const found: Identifiers = { emails: [], phones: [], organization: [], ignored: [] }
  if (type === "person") {
    found.contact = { provider: source.provider, externalId: crmIdentityId(source, externalId) }
    for (const email of valuesOf(fields.email)) {
      const address = email.trim().toLowerCase()
      if (isEmailAddress(address) && !found.emails.includes(address)) found.emails.push(address)
    }
    const region = options.phone_region?.toLowerCase()
    const phones = Array.isArray(fields.phone) ? fields.phone : [fields.phone]
    for (const [index, phone] of phones.entries()) {
      if (typeof phone !== "string") continue
      const value = e164Of(phone, region)
      if (value === null)
        found.ignored.push({
          at: ["fields", "phone", ...(Array.isArray(fields.phone) ? [index] : [])],
          reason: "record.phone-region",
        })
      else if (value !== undefined && !found.phones.includes(value)) found.phones.push(value)
    }
  }
  if (type === "organization")
    for (const [index, item] of (Array.isArray(fields.identifiers) ? fields.identifiers : []).entries()) {
      if (!isObject(item) || typeof item.scheme !== "string" || typeof item.value !== "string") continue
      if (!SCHEME.test(item.scheme) || !item.value.trim()) continue
      const value =
        item.scheme === "domain"
          ? domainOf(item.value)
          : item.scheme === "email"
            ? item.value.trim().toLowerCase()
            : item.value.trim()
      if (item.scheme === "domain" && FREE_MAIL.has(value))
        refusal(
          `${value} is a free mail domain: anyone has an address there, so it names no organization`,
          "record.identifier",
          ["fields", "identifiers", index, "value"],
        )
      found.organization.push({ provider: providerOf(item.scheme), value })
    }
  if (type === "project" && typeof fields.key === "string" && fields.key.trim())
    found.key = fields.key.trim().toUpperCase()
  return found
}

/**
 * The entities the identifiers point at, each once. A person is matched by the people matcher's lookup, which
 * `people.scanMatches` reads phones and addresses with too.
 */
export const entitiesByIdentifiers = (database: CacheDatabase, type: IdentityType, ids: Identifiers): number[] => {
  const found = new Set<number>()
  const add = (rows: Row[], column: string) => {
    for (const row of rows) found.add(Number(row[column]))
  }
  if (type === "person") for (const person of personsByIdentifiers(database, ids)) found.add(person)
  if (type === "organization") {
    const organization = database.prepare(
      "SELECT o.id FROM identities i JOIN organization_identities oi ON oi.identity_id = i.id " +
        "JOIN organizations o ON o.id = oi.organization_id WHERE o.deleted_at IS NULL AND i.provider = ? " +
        "AND i.external_id = ?",
    )
    for (const { provider, value } of ids.organization) {
      add(organization.all(provider, value), "id")
      // Mail findings and mentions give a company its address as an `email` identity; it is the same company.
      if (provider === ORG_EMAIL) add(organization.all("email", value), "id")
    }
  }
  if (type === "project" && ids.key !== undefined)
    add(database.prepare("SELECT id FROM projects WHERE key = ? AND deleted_at IS NULL").all(ids.key), "id")
  return [...found].sort((a, b) => a - b)
}

/** The identities the store already has for a person record's identifiers. */
const identitiesOf = (database: CacheDatabase, ids: Identifiers): number[] => {
  const pairs: [string, string][] = [
    ...ids.emails.map((value): [string, string] => ["email", value]),
    ...ids.phones.map((value): [string, string] => ["phone", value]),
    ...(ids.contact ? [[ids.contact.provider, ids.contact.externalId] as [string, string]] : []),
  ]
  return pairs.flatMap(([provider, value]) => {
    const row = database
      .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
      .get(provider, value)
    return row ? [Number(row.id)] : []
  })
}

/** Whether the owner separated `person` from an identity the record brings: linking would join what he told apart. */
export const separatedByOwner = (context: StoreContext, person: number, identities: number[]): boolean =>
  identities.some((identity) => identitySeparated(context, identity, person))

/** What the identifiers say: no entity, exactly one, or several the owner has to choose between. */
export const matchOf = (context: StoreContext, type: IdentityType, ids: Identifiers): Match => {
  const { database } = context
  const found = entitiesByIdentifiers(database, type, ids)
  if (found.length === 0) return { outcome: "none" }
  if (found.length > 1) return { outcome: "ambiguous", ids: found, reason: "record.ambiguous" }
  const id = found[0] as number
  if (type === "person" && separatedByOwner(context, id, identitiesOf(database, ids)))
    return { outcome: "ambiguous", ids: found, reason: "record.separated" }
  return { outcome: "one", id }
}

const IMPORT = "import"

/** The identity of `(provider, externalId)`, made when the store has none; never another person's. */
export const importedIdentity = (
  { database, now }: StoreContext,
  identity: { provider: string; externalId: string; name: string | null; email?: string; phone?: string },
): number => {
  const held = database
    .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
    .get(identity.provider, identity.externalId)
  if (held) return Number(held.id)
  const at = now()
  return Number(
    database
      .prepare(
        "INSERT INTO identities (provider, external_id, name, name_folded, email, phone, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(
        identity.provider,
        identity.externalId,
        identity.name,
        identity.name === null ? null : fold(identity.name),
        identity.email ?? null,
        identity.phone ?? null,
        at,
        at,
      )?.id,
  )
}

/** Gives a person the record brought these identifiers; an identity another person already has stays theirs. */
export const linkToPerson = (context: StoreContext, person: number, identity: number, source: EnvelopeSource) => {
  const { database, now } = context
  if (database.prepare("SELECT 1 FROM identity_links WHERE identity_id = ?").get(identity)) return
  if (identitySeparated(context, identity, person)) return
  const at = now()
  database
    .prepare(
      "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, source, " +
        "updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
    )
    .run(identity, person, IMPORT, at, IMPORT, `import:${source.provider}`, at)
  database
    .prepare(
      "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
        "VALUES (?, NULL, ?, ?, ?, ?)",
    )
    .run(identity, person, IMPORT, at, IMPORT)
}

/** Adds the record's identifiers to an entity the import made; never to one it linked by an identifier. */
export const addIdentifiers = (
  context: StoreContext,
  type: IdentityType,
  id: number,
  ids: Identifiers,
  name: string | null,
  source: EnvelopeSource,
) => {
  const { database, now } = context
  if (type === "person") {
    const [email] = ids.emails
    const [phone] = ids.phones
    if (ids.contact)
      linkToPerson(context, id, importedIdentity(context, { ...ids.contact, name, email, phone }), source)
    for (const address of ids.emails)
      linkToPerson(
        context,
        id,
        importedIdentity(context, { provider: "email", externalId: address, name, email: address }),
        source,
      )
    for (const value of ids.phones)
      linkToPerson(
        context,
        id,
        importedIdentity(context, { provider: "phone", externalId: value, name, phone: value }),
        source,
      )
  }
  if (type === "organization")
    for (const { provider, value } of ids.organization) {
      const identity = importedIdentity(context, { provider, externalId: value, name })
      const at = now()
      database
        .prepare(
          "INSERT OR IGNORE INTO organization_identities (identity_id, organization_id, method, author, created_at, " +
            "updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(identity, id, IMPORT, IMPORT, at, at)
    }
}

/** Makes the entity a record with no match stands for, marked by the caller as made by the import. */
export const createEntity = (
  context: StoreContext,
  type: IdentityType,
  fields: Row,
  ids: Identifiers,
  related: { organization?: number | null },
  source: EnvelopeSource,
  externalId: string,
): number => {
  const { database, now } = context
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : null
  const at = now()
  let id: number
  if (type === "person")
    id = Number(
      database
        .prepare("INSERT INTO persons (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id")
        .get(name, at, at)?.id,
    )
  else if (type === "organization")
    id = Number(
      database
        .prepare(
          "INSERT INTO organizations (kind, name, scope, created_at, updated_at) VALUES ('company', ?, 'work', ?, ?) " +
            "RETURNING id",
        )
        .get(name ?? `${source.provider} organization ${externalId}`, at, at)?.id,
    )
  else {
    const title = name ?? `${source.provider} project ${externalId}`
    const free =
      ids.key !== undefined &&
      /^[A-Z][A-Z0-9]{2,3}$/.test(ids.key) &&
      !database.prepare("SELECT 1 FROM projects WHERE key = ?").get(ids.key)
    const organization = related.organization == null ? undefined : `organization:${related.organization}`
    const row = insertProject(context, {
      name: title,
      ...(free ? { key: ids.key } : {}),
      ...(organization ? { organization } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      scope: "work",
    })
    id = Number(row.id)
  }
  addIdentifiers(context, type, id, ids, name, source)
  return id
}

/**
 * The name of an entity the import made follows the source, unless someone renamed it here: `before` is the name
 * the source gave last time.
 */
export const renameMade = (
  { database, now }: StoreContext,
  type: IdentityType,
  id: number,
  name: unknown,
  before: unknown,
) => {
  if (typeof name !== "string" || !name.trim() || name === before) return
  const table = RECORD_TABLES[type]
  const folded = type === "project" ? ", name_folded = ?" : ""
  database
    .prepare(`UPDATE ${table} SET name = ?${folded}, updated_at = ? WHERE id = ? AND name IS ?`)
    .run(
      ...[
        name.trim(),
        ...(type === "project" ? [fold(name.trim())] : []),
        now(),
        id,
        typeof before === "string" ? before : null,
      ],
    )
}
