import { crmGapsOf } from "../crm/index.js"
import { CATEGORIES, type Category } from "../domain/categories.js"
import { isUsable, type Standing } from "../domain/relations.js"
import type { AccountKey, KnowledgeRelation, MessageStore } from "../store/index.js"

/** Items a context section lists before it says `hasMore`. */
export const SECTION_LIMIT = 20
/** `knowledge.relations` answers at most this many: a full page may hold more. */
const RELATIONS_PAGE = 500

/**
 * A bounded list: the first `limit`, how many there are, and the memo command that lists the rest (a command of
 * memo's relationship and list words, plan §4.6–4.7); `null` when nothing was left out.
 */
export interface Section<T> {
  items: T[]
  total: number
  hasMore: boolean
  next: string | null
}

export const sectionOf = <T>(all: T[], limit: number, next: string, more = false): Section<T> => ({
  items: all.slice(0, limit),
  total: all.length,
  hasMore: more || all.length > limit,
  next: more || all.length > limit ? next : null,
})

/** One relationship, as seen from the entity a context is about. */
export interface RelationRole {
  /** `link:<id>`. */
  link: string
  kind: KnowledgeRelation["kind"]
  role: string | null
  standing: Standing
  /** The source account that reported it, `<provider>:<account>`. */
  account?: string
  position?: string
  derived?: string
  startsAt?: string
  endsAt?: string
}

/** Another entity and every relationship joining it to the one asked about: counted once however many. */
export interface Related {
  ref: string
  name: string | null
  roles: RelationRole[]
}

/** What a context read, and what it did not and why: `notRead` names a missing source, never fills the gap. */
export interface Coverage {
  /** `<provider>:<account>` of every account read. */
  accounts: string[]
  notRead: { source: string; reason: string }[]
}

/**
 * `coverage` with what each CRM account in scope said its last sync could not read, such as reporting lines with no
 * department scope: named, never filled in.
 */
export const withCrmGaps = async (
  store: MessageStore,
  coverage: Coverage,
  accounts: AccountKey[] | undefined,
): Promise<Coverage> => {
  const keyOf = (key: AccountKey) => `${key.provider}:${key.account}`
  const asked = accounts === undefined ? undefined : new Set(accounts.map(keyOf))
  const notRead = [...coverage.notRead]
  for (const key of await store.accounts.accounts())
    if (asked === undefined || asked.has(keyOf(key)))
      for (const gap of await crmGapsOf(store, key)) notRead.push({ source: keyOf(key), reason: gap.message })
  return { ...coverage, notRead }
}

const roleOf = (relation: KnowledgeRelation): RelationRole => ({
  link: `link:${relation.id}`,
  kind: relation.kind,
  role: relation.role,
  standing: relation.standing,
  ...(relation.account === undefined ? {} : { account: relation.account }),
  ...(relation.position === undefined ? {} : { position: relation.position }),
  ...(relation.derived === undefined ? {} : { derived: relation.derived }),
  ...(relation.startsAt === undefined ? {} : { startsAt: relation.startsAt }),
  ...(relation.endsAt === undefined ? {} : { endsAt: relation.endsAt }),
})

/** Every relationship touching `ref`, both ways, with its standing; `full` when the store's page was full. */
export const relationsOf = async (
  store: MessageStore,
  ref: string,
): Promise<{ relations: KnowledgeRelation[]; full: boolean }> => {
  const relations = await store.knowledge.relations(null, ref)
  return { relations, full: relations.length >= RELATIONS_PAGE }
}

/** A title for each ref, read in one batch. */
export const namesOf = async (store: MessageStore, refs: Iterable<string>): Promise<Map<string, string | null>> => {
  const summaries = await store.refs.summaries([...new Set(refs)])
  return new Map([...summaries].map(([ref, summary]) => [ref, summary.title]))
}

/**
 * The other ends of `relations` that `pick` keeps, each once with all its roles; one still usable sorts first, so
 * the current relationships lead and the ended ones follow.
 */
export const grouped = (
  relations: KnowledgeRelation[],
  pick: (relation: KnowledgeRelation) => string | undefined,
  names: Map<string, string | null>,
): Related[] => {
  const byRef = new Map<string, Related>()
  for (const relation of relations) {
    const ref = pick(relation)
    if (ref === undefined) continue
    const held = byRef.get(ref) ?? { ref, name: names.get(ref) ?? null, roles: [] }
    held.roles.push(roleOf(relation))
    byRef.set(ref, held)
  }
  const current = (one: Related) => (one.roles.some((role) => isUsable(role.standing)) ? 0 : 1)
  return [...byRef.values()].sort((a, b) => current(a) - current(b))
}

/** The other end of a relationship, when `ref` is one end of it. */
export const otherEnd = (relation: KnowledgeRelation, ref: string): string | undefined =>
  relation.from === ref ? relation.to : relation.to === ref ? relation.from : undefined

export { CATEGORIES, type Category }

/** The roles that make an organization the owner's employer. */
const EMPLOYED = new Set(["employee", "contractor", "founder"])

/**
 * Each organization's categories, derived from usable relationships and never stored (NEED-2377): `client` is
 * `customer-of` an own organization, `supplier` one an own organization is `customer-of`, `partner` `partner-of` one,
 * `employer` one the owner's person is `member-of` as employee, contractor or founder.
 */
export const organizationCategories = async (store: MessageStore): Promise<Map<string, Category[]>> => {
  const found = new Map<string, Set<Category>>()
  const add = (ref: string, category: Category) => found.set(ref, (found.get(ref) ?? new Set()).add(category))
  for (const own of await store.knowledge.ownOrganizations())
    for (const relation of (await relationsOf(store, own.ref)).relations) {
      if (!isUsable(relation.standing)) continue
      const other = otherEnd(relation, own.ref)
      if (!other?.startsWith("organization:")) continue
      if (relation.kind === "customer-of") add(other, relation.to === own.ref ? "client" : "supplier")
      if (relation.kind === "partner-of") add(other, "partner")
    }
  const owner = await store.people.owner()
  if (owner)
    for (const relation of (await relationsOf(store, `person:${owner.uid}`)).relations)
      if (
        isUsable(relation.standing) &&
        relation.kind === "member-of" &&
        relation.to.startsWith("organization:") &&
        EMPLOYED.has(relation.role ?? "")
      )
        add(relation.to, "employer")
  return new Map([...found].map(([ref, categories]) => [ref, CATEGORIES.filter((one) => categories.has(one))]))
}

/** What `organizations list category:<c>` lists: the organizations of one category, as `organizations` has them. */
export const organizationsInCategory = async (store: MessageStore, category: Category) => {
  const categories = await organizationCategories(store)
  return (await store.knowledge.organizations()).filter((one) => categories.get(one.ref)?.includes(category))
}
