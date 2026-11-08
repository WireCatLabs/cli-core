import { typedPhone } from "../../domain/mentions.js"
import type { IdentityType } from "../../domain/record-types.js"
import type { EnvelopeSource } from "../../domain/records.js"
import { FREE_MAIL } from "../../mail/score.js"
import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import { crmIdentityId } from "./crm.js"
import { insertProject } from "./knowledge.js"
import type { StoreContext } from "./open.js"
import { storePhoneCountries } from "./phone-countries.js"
import { type Row, refusal } from "./record-projection.js"

/** The strong identifiers a person, organization or project record gives; a name is never one. */
export interface Identifiers {
  /** Lower-cased. */
  emails: string[]
  /** E.164. */
  phones: string[]
  /** The source's own contact identity, `<account>/contact/<external id>` under its provider, as CRM sync writes it. */
  contact?: { provider: string; externalId: string }
  /** `{scheme, value}` of an organization, the scheme as the identity's provider. */
  organization: { scheme: string; value: string }[]
  /** A project's key, upper-cased. */
  key?: string
}

export type Match =
  | { outcome: "none" }
  | { outcome: "one"; id: number }
  | { outcome: "ambiguous"; ids: number[]; reason: string }

const listOf = (value: unknown): string[] =>
  value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]).map(String)

const domainOf = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")

/** A record's identifiers, refused (`record.identifier`) when one cannot be read as the scheme it claims. */
export const identifiersOf = (
  database: CacheDatabase,
  type: IdentityType,
  fields: Row,
  source: EnvelopeSource,
  externalId: string,
): Identifiers => {
  const found: Identifiers = { emails: [], phones: [], organization: [] }
  if (type === "person") {
    found.contact = { provider: source.provider, externalId: crmIdentityId(source, externalId) }
    for (const [index, email] of listOf(fields.email).entries()) {
      const address = email.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
        refusal(`${email} is not an e-mail address`, "record.identifier", ["fields", "email", index])
      found.emails.push(address)
    }
    const phoneCountries = storePhoneCountries(database)
    for (const [index, phone] of listOf(fields.phone).entries()) {
      const value = typedPhone(phone, { phoneCountries })?.value
      if (value === undefined || !value.startsWith("+"))
        refusal(
          `${phone} is not a phone number in international form, nor one the phone_countries setting reads`,
          "record.identifier",
          ["fields", "phone", index],
        )
      found.phones.push(value as string)
    }
  }
  if (type === "organization") {
    const identifiers = Array.isArray(fields.identifiers) ? (fields.identifiers as Row[]) : []
    for (const [index, { scheme, value }] of identifiers.entries()) {
      const kind = String(scheme)
      const text = kind === "email" ? String(value).trim().toLowerCase() : String(value).trim()
      const normalized = kind === "domain" ? domainOf(text) : text
      if (kind === "domain" && FREE_MAIL.has(normalized))
        refusal(
          `${normalized} is a free mail domain: anyone has an address there, so it names no organization`,
          "record.identifier",
          ["fields", "identifiers", index, "value"],
        )
      found.organization.push({ scheme: kind, value: normalized })
    }
  }
  if (type === "project" && typeof fields.key === "string") found.key = fields.key.trim().toUpperCase()
  return [...new Set(found.emails)].length === found.emails.length
    ? found
    : { ...found, emails: [...new Set(found.emails)] }
}

/**
 * The entities the identifiers point at, each once. The one lookup an import matches by: the Memory workstream's
 * shared matcher (D5) takes it over as it is, so it reads the store and nothing else.
 */
export const entitiesByIdentifiers = (database: CacheDatabase, type: IdentityType, ids: Identifiers): number[] => {
  const found = new Set<number>()
  const add = (rows: Row[], column: string) => {
    for (const row of rows) found.add(Number(row[column]))
  }
  if (type === "person") {
    const person = database.prepare(
      "SELECT DISTINCT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE (i.provider = 'email' AND lower(i.external_id) = ?) OR lower(i.email) = ?",
    )
    for (const email of ids.emails) add(person.all(email, email), "person_id")
    const phone = database.prepare(
      "SELECT DISTINCT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.provider = 'phone' AND i.external_id = ?",
    )
    for (const value of ids.phones) add(phone.all(value), "person_id")
    if (ids.contact)
      add(
        database
          .prepare(
            "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
              "WHERE i.provider = ? AND i.external_id = ?",
          )
          .all(ids.contact.provider, ids.contact.externalId),
        "person_id",
      )
  }
  if (type === "organization") {
    const organization = database.prepare(
      "SELECT DISTINCT o.id FROM identities i JOIN organization_identities oi ON oi.identity_id = i.id " +
        "JOIN organizations o ON o.id = oi.organization_id WHERE o.deleted_at IS NULL AND i.provider = ? " +
        "AND i.external_id = ?",
    )
    for (const { scheme, value } of ids.organization) add(organization.all(scheme, value), "id")
  }
  if (type === "project" && ids.key !== undefined)
    add(database.prepare("SELECT id FROM projects WHERE key = ? AND deleted_at IS NULL").all(ids.key), "id")
  return [...found].sort((a, b) => a - b)
}

/**
 * Whether the owner separated `person` from anyone these identifiers belong to, so linking would join two people he
 * told apart. TODO(cli-messaging-19 D1): call `separated()`/`identitySeparated()` from
 * `src/store/sqlite/person-separation.ts` once that branch is merged; until then no separation is stored to read.
 */
export const separatedByOwner = (_database: CacheDatabase, _person: number, _ids: Identifiers): boolean => false

/** What the identifiers say: no entity, exactly one, or several the owner has to choose between. */
export const matchOf = (database: CacheDatabase, type: IdentityType, ids: Identifiers): Match => {
  const found = entitiesByIdentifiers(database, type, ids)
  if (found.length === 0) return { outcome: "none" }
  if (found.length > 1)
    return { outcome: "ambiguous", ids: found, reason: `the identifiers belong to ${found.length} ${type} entities` }
  const id = found[0] as number
  if (type === "person" && separatedByOwner(database, id, ids))
    return { outcome: "ambiguous", ids: found, reason: "the owner separated these identities from that person" }
  return { outcome: "one", id }
}

const IMPORT = "import"

/** The identity of `(provider, externalId)`, made when the store has none; never another person's. */
const identityPk = (
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
const linkToPerson = (context: StoreContext, person: number, identity: number, source: EnvelopeSource) => {
  const { database, now } = context
  if (database.prepare("SELECT 1 FROM identity_links WHERE identity_id = ?").get(identity)) return
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
    if (ids.contact) linkToPerson(context, id, identityPk(context, { ...ids.contact, name, email, phone }), source)
    for (const address of ids.emails)
      linkToPerson(
        context,
        id,
        identityPk(context, { provider: "email", externalId: address, name, email: address }),
        source,
      )
    for (const value of ids.phones)
      linkToPerson(
        context,
        id,
        identityPk(context, { provider: "phone", externalId: value, name, phone: value }),
        source,
      )
  }
  if (type === "organization")
    for (const { scheme, value } of ids.organization) {
      const identity = identityPk(context, { provider: scheme, externalId: value, name })
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
  const table = type === "person" ? "persons" : type === "organization" ? "organizations" : "projects"
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
