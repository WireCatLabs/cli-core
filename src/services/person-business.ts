import { CliError } from "@wirecat/cli-base"
import type { DealKind } from "../domain/deals.js"
import { isUsable } from "../domain/relations.js"
import type { AccountKey, MessageStore, PersonRecord } from "../store/store.js"
import {
  CATEGORIES,
  type Category,
  type Coverage,
  coverageFor,
  type Edge,
  edgesOf,
  grouped,
  keyOf,
  namesOf,
  organizationCategories,
  type Related,
  type Scope,
  SECTION_LIMIT,
  type Section,
  scopeOf,
  sectionOf,
  usable,
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
  /** `client` when they are `customer-of` an own organization, and each category of an organization they belong to. */
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
  /** The kinds the profile denies: no deal or lead of theirs is named. */
  deniedKinds?: readonly DealKind[]
}

export const personBusiness = async (
  store: MessageStore,
  uid: string,
  { limit = SECTION_LIMIT, scope = scopeOf(undefined) }: { limit?: number; scope?: Scope } = {},
): Promise<PersonBusiness> => {
  const ref = `person:${uid}`
  const { edges, full } = await edgesOf(store, ref, scope)
  const names = await namesOf(
    store,
    edges.flatMap(({ from, to }) => [from, to]),
  )
  const outward = (kind: string, to: string) => (edge: Edge) =>
    edge.role.kind === kind && edge.from === ref && edge.to.startsWith(to) ? edge.to : undefined
  const categories = await organizationCategories(store, scope)
  const own = new Set((await store.knowledge.ownOrganizations()).map((one) => one.ref))
  const about = `about:${ref}`
  const more = { more: full }
  const organizations = grouped(edges, outward("member-of", "organization:"), names).map((one) => ({
    ...one,
    categories: categories.get(one.ref) ?? [],
  }))
  const held = new Set<Category>()
  if (edges.some((edge) => usable(edge) && edge.role.kind === "customer-of" && edge.from === ref && own.has(edge.to)))
    held.add("client")
  for (const one of organizations)
    if (one.roles.some((role) => isUsable(role.standing))) for (const category of one.categories) held.add(category)
  return {
    organizations: sectionOf(organizations, limit, `relationships list ${about} kind:member-of`, more),
    reportsTo: sectionOf(
      grouped(edges, outward("reports-to", "person:"), names),
      limit,
      `relationships list from:${ref} kind:reports-to`,
      more,
    ),
    directReports: sectionOf(
      grouped(edges, (edge) => (edge.role.kind === "reports-to" && edge.to === ref ? edge.from : undefined), names),
      limit,
      `relationships list to:${ref} kind:reports-to`,
      more,
    ),
    deals: sectionOf(
      grouped(
        edges,
        (edge) =>
          edge.role.kind === "related-to" && edge.to === ref && /^(deal|lead):/.test(edge.from) ? edge.from : undefined,
        names,
      ),
      limit,
      `relationships list ${about} kind:related-to`,
      more,
    ),
    projects: sectionOf(
      grouped(edges, outward("member-of", "project:"), names),
      limit,
      `relationships list ${about} kind:member-of`,
      more,
    ),
    categories: CATEGORIES.filter((one) => held.has(one)),
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
  { accounts, limit, deniedKinds, ...options }: CanonicalContextOptions = {},
): Promise<CanonicalPersonContext> => {
  const uid = /^person:(\d+)$/.exec(reference.trim())?.[1]
  if (uid === undefined) throw new CliError("validation_error", "a person is person:<id>")
  const record = await store.people.personByUid(uid)
  if (!record) throw new CliError("not_found", `no person:${uid} in the store`)
  const scope = scopeOf(accounts, deniedKinds)
  const stored = await store.accounts.storedAccounts()
  // The scope is the caller's: every stored account it holds is readable, whatever its personal or work scope.
  const readable = stored.filter((one) => scope.has(one))
  const scopes = new Map(stored.map((one) => [keyOf(one), one.scope]))
  const reads = readsIn(stored, record, scope).map((one) => ({
    ...one,
    scope: scopes.get(keyOf(one.key)) as (typeof stored)[number]["scope"],
  }))
  const calendars = (await calendarsOf(store, stored)).filter((one) => scope.has(one))
  const read = [...reads.map(({ key }) => keyOf(key)), ...calendars.map(keyOf)]
  return {
    person: record,
    ...(await recordContext(store, record, reads, readable, {
      ...options,
      ...(accounts === undefined ? {} : { calendarIds: calendars.map(({ id }) => id) }),
    })),
    business: await personBusiness(store, uid, { ...(limit === undefined ? {} : { limit }), scope }),
    coverage: await coverageFor(store, coverageOf([record], read, calendars.length > 0), scope),
  }
}
