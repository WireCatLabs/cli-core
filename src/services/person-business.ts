import { CliError } from "@wirecat/cli-base"
import { isUsable } from "../domain/relations.js"
import type { AccountKey, MessageStore, PersonRecord } from "../store/store.js"
import {
  type Category,
  type Coverage,
  grouped,
  namesOf,
  organizationCategories,
  type Related,
  relationsOf,
  SECTION_LIMIT,
  type Section,
  sectionOf,
  withCrmGaps,
} from "./business-context.js"
import { calendarsOf, coverageOf, readsIn } from "./communications.js"
import { type ContextOptions, type PersonContext, recordContext } from "./person-context.js"

/** What a person is in the owner's business, each relationship with its standing. */
export interface PersonBusiness {
  organizations: Section<Related & { categories: Category[] }>
  /** Whom they report to. */
  reportsTo: Section<Related>
  /** Who reports to them: `reports-to` read backwards, "manages". */
  directReports: Section<Related>
  /** Deals and leads they are on, with their roles there. */
  deals: Section<Related>
  projects: Section<Related>
  /** `client` when they are `customer-of` one of the owner's organizations. */
  categories: Category[]
}

/** `personContext` of any canonical person, with no account to ask from: every account in scope is read. */
export interface CanonicalPersonContext extends Omit<PersonContext, "person"> {
  person: PersonRecord
  business: PersonBusiness
  coverage: Coverage
}

export interface CanonicalContextOptions extends ContextOptions {
  /** The accounts read; left out, every account in the store, and `coverage.accounts` names them. */
  accounts?: AccountKey[]
  /** Items per business section. */
  limit?: number
}

export const personBusiness = async (
  store: MessageStore,
  uid: string,
  limit = SECTION_LIMIT,
): Promise<PersonBusiness> => {
  const ref = `person:${uid}`
  const { relations, full } = await relationsOf(store, ref)
  const names = await namesOf(
    store,
    relations.flatMap(({ from, to }) => [from, to]),
  )
  const outward = (kind: string, to: string) => (relation: (typeof relations)[number]) =>
    relation.kind === kind && relation.from === ref && relation.to.startsWith(to) ? relation.to : undefined
  const categories = await organizationCategories(store)
  const own = new Set((await store.knowledge.ownOrganizations()).map((one) => one.ref))
  const about = `about:${ref}`
  return {
    organizations: sectionOf(
      grouped(relations, outward("member-of", "organization:"), names).map((one) => ({
        ...one,
        categories: categories.get(one.ref) ?? [],
      })),
      limit,
      `relationships list ${about} kind:member-of`,
      full,
    ),
    reportsTo: sectionOf(
      grouped(relations, outward("reports-to", "person:"), names),
      limit,
      `relationships list from:${ref} kind:reports-to`,
      full,
    ),
    directReports: sectionOf(
      grouped(
        relations,
        (relation) => (relation.kind === "reports-to" && relation.to === ref ? relation.from : undefined),
        names,
      ),
      limit,
      `relationships list to:${ref} kind:reports-to`,
      full,
    ),
    deals: sectionOf(
      grouped(
        relations,
        (relation) =>
          relation.kind === "related-to" && relation.to === ref && /^(deal|lead):/.test(relation.from)
            ? relation.from
            : undefined,
        names,
      ),
      limit,
      `relationships list ${about} kind:related-to`,
      full,
    ),
    projects: sectionOf(
      grouped(relations, outward("member-of", "project:"), names),
      limit,
      `relationships list ${about} kind:member-of`,
      full,
    ),
    categories: relations.some(
      (relation) =>
        relation.kind === "customer-of" && relation.from === ref && own.has(relation.to) && isUsable(relation.standing),
    )
      ? ["client"]
      : [],
  }
}

/**
 * What the store knows about one canonical person, by `person:<uid>`: a CRM contact, a name the owner added, or
 * someone seen by several accounts alike. Every identity is read in every account in scope that saw it — never one
 * picked for them (WC-ACCT-9) — and `coverage` says what was read and what was not.
 */
export const canonicalPersonContext = async (
  store: MessageStore,
  reference: string,
  { accounts, limit, ...options }: CanonicalContextOptions = {},
): Promise<CanonicalPersonContext> => {
  const uid = /^person:(\d+)$/.exec(reference.trim())?.[1]
  if (uid === undefined) throw new CliError("validation_error", "a person is person:<id>")
  const record = await store.people.personByUid(uid)
  if (!record) throw new CliError("not_found", `no person:${uid} in the store`)
  const stored = await store.accounts.storedAccounts()
  const { reads, left } = readsIn(stored, record, accounts)
  const keyOf = (key: AccountKey) => `${key.provider}:${key.account}`
  const inScope = (await calendarsOf(store, stored)).filter(
    (one) => accounts === undefined || accounts.some((key) => keyOf(key) === keyOf(one)),
  )
  const read = [...reads.map(({ key }) => keyOf(key)), ...inScope.map(keyOf)]
  return {
    person: record,
    ...(await recordContext(store, record, reads, {
      ...options,
      ...(accounts === undefined ? {} : { calendarIds: inScope.map(({ id }) => id) }),
    })),
    business: await personBusiness(store, uid, limit),
    coverage: await withCrmGaps(store, coverageOf([record], read, left, inScope.length > 0), accounts),
  }
}
