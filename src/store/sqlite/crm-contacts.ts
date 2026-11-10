import type { AccountKey } from "../types.js"
import { findAccountPk, OWN, referencesTo } from "./accounts.js"
import { crmAccountPrefix, crmIdentityId } from "./crm-rows.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

/** What removing a CRM account's contacts outside its scope did, or would do. */
export interface CrmContactsRemoved {
  /** Contacts no kept deal, lead or company names, removed with their link to a person. */
  contacts: number
  /** People those contacts made, deleted because nothing else was left on them. */
  persons: number
  /** People those contacts were on that stay: another identity, a note, an alias, the owner's decision, a mention. */
  personsKept: number
  /** People whose name still carried a CRM import's `null #<id>`, given the name without it. */
  names: number
}

/** A CRM import can leave `null` or `null #<id>` in a name field; no person is called that. */
const PLACEHOLDER = /(?:^|\s)null(?:\s+#\d+)?(?=\s|$)/gi

export const withoutPlaceholder = (name: string): string | null =>
  name.replace(PLACEHOLDER, " ").replace(/\s+/g, " ").trim() || null

class DryRun extends Error {
  constructor(readonly counts: CrmContactsRemoved) {
    super("dry run")
  }
}

const NONE: CrmContactsRemoved = { contacts: 0, persons: 0, personsKept: 0, names: 0 }

/**
 * Removes, in one transaction, every contact of the account that no kept deal or lead (not deleted, and inside
 * `users` when given) names in a client's role, and that is no contact of a kept company. A contact the owner decided
 * about, or one anything else points at, stays; so does one saved at or after `before`, whose deal may still be on
 * its way. A person the removed contacts leave empty is deleted unless anything still points at them. People named
 * after a contact keep that name without the import's `null #<id>`; the owner's person is never renamed.
 */
export const removeCrmContacts = (
  context: StoreContext,
  key: AccountKey,
  { users, before, dryRun = false }: { users?: readonly string[]; before: number; dryRun?: boolean },
): CrmContactsRemoved => {
  const { database } = context
  const accountId = findAccountPk(context, key)
  if (accountId === undefined) return NONE
  const prefix = `${crmAccountPrefix(key)}contact/`
  const contactOf = "i.provider = ? AND substr(i.external_id, 1, ?) = ?"
  const contact = [key.provider, prefix.length, prefix]
  const inScope = (item: string) =>
    users === undefined
      ? ""
      : `AND (json_extract(${item}.metadata, '$.assignee') IS NULL OR ` +
        `json_extract(${item}.metadata, '$.assignee') IN (SELECT id FROM temp.crm_scope))`
  const named = (table: "deals" | "leads", type: "deal" | "lead") =>
    `EXISTS (SELECT 1 FROM links k JOIN ${table} d ON d.id = k.from_id WHERE k.to_type = 'person' ` +
    `AND k.to_id = l.person_id AND k.from_type = '${type}' AND k.source = 'crm' AND k.role IS NOT 'owner' ` +
    `AND k.deleted_at IS NULL AND d.account_id = ${accountId} AND d.deleted_at IS NULL ${inScope("d")})`
  const counted = (): CrmContactsRemoved => {
    for (const table of ["crm_scope", "crm_gone", "crm_persons", "crm_names", "crm_proposed"])
      database.exec(`DROP TABLE IF EXISTS temp.${table}`)
    database.exec("CREATE TEMP TABLE crm_scope (id TEXT PRIMARY KEY)")
    database.exec("CREATE TEMP TABLE crm_gone (id INTEGER PRIMARY KEY, person INTEGER)")
    database.exec("CREATE TEMP TABLE crm_persons (id INTEGER PRIMARY KEY)")
    database.exec("CREATE TEMP TABLE crm_names (id INTEGER PRIMARY KEY, name TEXT)")
    database.exec("CREATE TEMP TABLE crm_proposed (ref TEXT PRIMARY KEY, decided INTEGER NOT NULL)")
    database
      .prepare("INSERT INTO temp.crm_scope SELECT DISTINCT value FROM json_each(?)")
      .run(JSON.stringify((users ?? []).map((id) => crmIdentityId(key, id, "user"))))
    // An identity link the owner approved or rejected is his decision about this contact; one only proposed is not.
    database.exec(
      "INSERT INTO temp.crm_proposed SELECT ref, max(decided) FROM (" +
        "SELECT json_extract(payload, '$.identity') AS ref, status <> 'proposed' AS decided FROM proposed_actions " +
        "WHERE kind = 'identity_link' UNION ALL SELECT json_extract(payload, '$.with'), status <> 'proposed' " +
        "FROM proposed_actions WHERE kind = 'identity_link') WHERE ref IS NOT NULL GROUP BY ref",
    )
    const identityRefs = referencesTo(
      database,
      "identities",
      new Set([...OWN, "account_identities", "involvements"]),
      "SELECT id FROM temp.crm_gone",
    )
    database
      .prepare(
        "INSERT INTO temp.crm_gone SELECT i.id, l.person_id FROM identities i " +
          `LEFT JOIN identity_links l ON l.identity_id = i.id WHERE ${contactOf} ` +
          "AND i.created_at < ? AND i.updated_at < ? " +
          `AND NOT ${named("deals", "deal")} AND NOT ${named("leads", "lead")} ` +
          "AND NOT EXISTS (SELECT 1 FROM links k JOIN records r ON r.entity_type = 'organization' " +
          "AND r.entity_id = k.to_id WHERE k.from_type = 'person' AND k.from_id = l.person_id " +
          "AND +k.to_type = 'organization' AND k.kind = 'member-of' AND k.role = 'contact' AND k.source = 'crm' " +
          `AND k.deleted_at IS NULL AND r.account_id = ${accountId} AND r.type = 'organization' ` +
          "AND r.deleted_at IS NULL) " +
          "AND NOT EXISTS (SELECT 1 FROM identity_link_events e WHERE e.identity_id = i.id AND e.author = 'owner') " +
          "AND NOT EXISTS (SELECT 1 FROM temp.crm_proposed c WHERE c.decided AND c.ref = i.provider || ':' || " +
          "i.external_id)",
      )
      .run(...contact, before, before)
    database.exec(`DELETE FROM temp.crm_gone WHERE id IN (${identityRefs})`)
    // A same-email join left the contact's first person empty; it goes too, unless something points at it.
    database.exec("INSERT OR IGNORE INTO temp.crm_persons SELECT person FROM temp.crm_gone WHERE person IS NOT NULL")
    database.exec(
      "INSERT OR IGNORE INTO temp.crm_persons SELECT from_person_id FROM identity_link_events " +
        "WHERE identity_id IN (SELECT id FROM temp.crm_gone) AND from_person_id IS NOT NULL",
    )
    const names = database
      .prepare(
        "SELECT DISTINCT p.id, p.name, i.name AS was FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
          `JOIN persons p ON p.id = l.person_id WHERE ${contactOf} AND p.owner = 0 AND p.name LIKE '%null%'`,
      )
      .all(...contact)
      .flatMap((row) => {
        const name = String(row.name)
        const clean = withoutPlaceholder(name)
        const was = typeof row.was === "string" ? withoutPlaceholder(row.was) : null
        return clean !== name && clean === was ? [{ id: Number(row.id), name: clean }] : []
      })
    database
      .prepare(
        "INSERT OR IGNORE INTO temp.crm_names SELECT json_extract(value, '$.id'), json_extract(value, '$.name') " +
          "FROM json_each(?)",
      )
      .run(JSON.stringify(names))
    const gone = "(SELECT id FROM temp.crm_gone)"
    const persons = "(SELECT id FROM temp.crm_persons)"
    database
      .prepare(
        `DELETE FROM links WHERE source = 'crm' AND account_id = ? AND ((to_type = 'person' AND to_id IN ${persons} ` +
          "AND from_type IN ('deal', 'lead') AND role IS NOT 'owner') OR (from_type = 'person' " +
          `AND from_id IN ${persons} AND kind = 'member-of' AND role = 'contact'))`,
      )
      .run(accountId)
    database.exec(
      "DELETE FROM proposed_actions WHERE kind = 'identity_link' AND status = 'proposed' AND (" +
        `json_extract(payload, '$.identity') IN (SELECT provider || ':' || external_id FROM identities WHERE id IN ${gone}) ` +
        `OR json_extract(payload, '$.with') IN (SELECT provider || ':' || external_id FROM identities WHERE id IN ${gone}))`,
    )
    for (const table of ["identity_revisions", "identity_link_events", "identity_links", "account_identities"])
      database.exec(`DELETE FROM ${table} WHERE identity_id IN ${gone}`)
    const contacts = database.prepare(`DELETE FROM identities WHERE id IN ${gone}`).run().changes
    // Involvements are worked out again from what is left; they keep no one.
    const personRefs = referencesTo(
      database,
      "persons",
      new Set(["identity_links", "involvements"]),
      "SELECT id FROM temp.crm_persons",
    )
    // A proposal names its people in its payload: deleting one would leave the owner's answer about nobody.
    const proposed =
      "SELECT CAST(substr(value, 8) AS INTEGER) AS id FROM proposed_actions, json_each(json_array(" +
      "json_extract(payload, '$.from'), json_extract(payload, '$.to'))) WHERE value LIKE 'person:%' " +
      "UNION SELECT CAST(value AS INTEGER) FROM proposed_actions, json_each(payload, '$.persons') " +
      "WHERE json_type(payload, '$.persons') = 'array'"
    database.exec(
      `DELETE FROM temp.crm_persons WHERE id IN (SELECT id FROM persons WHERE owner <> 0) ` +
        "OR id IN (SELECT person_id FROM identity_links) " +
        `OR id IN (${personRefs}) OR id IN (${proposed})`,
    )
    database.exec(`DELETE FROM involvements WHERE person_id IN ${persons}`)
    const deleted = database.prepare(`DELETE FROM persons WHERE id IN ${persons}`).run().changes
    const personsKept = Number(
      database
        .prepare("SELECT count(DISTINCT person) AS n FROM temp.crm_gone WHERE person IN (SELECT id FROM persons)")
        .get()?.n,
    )
    const renamed = database
      .prepare(
        "UPDATE persons SET name = (SELECT name FROM temp.crm_names n WHERE n.id = persons.id), updated_at = ? " +
          "WHERE id IN (SELECT id FROM temp.crm_names)",
      )
      .run(context.now()).changes
    return { contacts, persons: deleted, personsKept, names: renamed }
  }
  try {
    return write(database, () => {
      const counts = counted()
      if (dryRun) throw new DryRun(counts)
      return counts
    })
  } catch (error) {
    if (error instanceof DryRun) return error.counts
    throw error
  }
}
