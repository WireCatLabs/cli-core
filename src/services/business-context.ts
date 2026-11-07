import { crmGapsOf } from "../crm/index.js"
import { CATEGORIES, type Category } from "../domain/categories.js"
import { isUsable, type Standing } from "../domain/relations.js"
import type { AccountKey, KnowledgeRelation, MessageStore } from "../store/index.js"

/** Items a context section lists before it says `hasMore`. */
export const SECTION_LIMIT = 20
/** What one store list answers at most: a read that fills it may hold more. */
export const STORE_PAGE = 500

/**
 * A bounded list: the first `limit`, how many there are, and the memo command that lists the rest; `null` when
 * nothing was left out or no one command lists exactly the rest.
 */
export interface Section<T> {
  items: T[]
  total: number
  hasMore: boolean
  next: string | null
}

export const sectionOf = <T>(
  all: T[],
  limit: number,
  next: string | null,
  { more = false, total = all.length, newest = false }: { more?: boolean; total?: number; newest?: boolean } = {},
): Section<T> => {
  const cut = more || total > limit || all.length > limit
  return {
    items: newest ? all.slice(Math.max(0, all.length - limit)) : all.slice(0, limit),
    total,
    hasMore: cut,
    next: cut ? next : null,
  }
}

export const keyOf = ({ provider, account }: AccountKey): string => `${provider}:${account}`

/**
 * The accounts a context reads, the caller's `--source` or group already resolved; every account when none is
 * given. A row no account reported — the owner's, an agent's — is always in it. `left` collects every account whose
 * rows were kept out, so `coverage` can say so.
 */
export interface Scope {
  accounts: AccountKey[] | undefined
  has(account: AccountKey | string | null | undefined): boolean
  left: Set<string>
}

export const scopeOf = (accounts: AccountKey[] | undefined): Scope => {
  const asked = accounts && new Set(accounts.map(keyOf))
  const left = new Set<string>()
  return {
    accounts,
    left,
    has: (account) => {
      if (account == null) return true
      const key = typeof account === "string" ? account : keyOf(account)
      if (asked === undefined || asked.has(key)) return true
      left.add(key)
      return false
    },
  }
}

export const notRejected = <T extends { review: string }>(rows: T[]): T[] =>
  rows.filter((row) => row.review !== "rejected")

/** One relationship, as seen from the entity a context is about: a link, or a proposal waiting for the owner. */
export interface RelationRole {
  /** `link:<id>`; absent for a proposal. */
  link?: string
  /** The pending `relationship` proposal's id, when it is one (`standing: proposed`). */
  proposal?: string
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

/** A relationship's two ends and what it is, whether a link or a proposal. */
export interface Edge {
  from: string
  to: string
  role: RelationRole
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

/**
 * Every relationship touching `ref`, both ways, in scope: its links with their standing, and the `relationship`
 * proposals waiting for the owner (plan §2.4). `full` when a store page was full and more may exist.
 */
export const edgesOf = async (
  store: MessageStore,
  ref: string,
  scope: Scope,
): Promise<{ edges: Edge[]; full: boolean }> => {
  const relations = await store.knowledge.relations(null, ref)
  const proposals = await store.proposedActions.list({
    kinds: ["relationship"],
    status: "proposed",
    about: ref,
    limit: STORE_PAGE,
  })
  const edges: Edge[] = relations
    .filter((relation) => scope.has(relation.account))
    .map((relation) => ({ from: relation.from, to: relation.to, role: roleOf(relation) }))
  for (const proposal of proposals) {
    const payload = proposal.payload as { from?: unknown; to?: unknown; kind?: unknown; role?: unknown }
    if (typeof payload.from !== "string" || typeof payload.to !== "string" || typeof payload.kind !== "string") continue
    if (!scope.has(proposal.account)) continue
    edges.push({
      from: payload.from,
      to: payload.to,
      role: {
        proposal: proposal.id,
        kind: payload.kind as KnowledgeRelation["kind"],
        role: typeof payload.role === "string" ? payload.role : null,
        standing: "proposed",
      },
    })
  }
  return { edges, full: relations.length >= STORE_PAGE || proposals.length >= STORE_PAGE }
}

/** A title for each ref, read in one batch. */
export const namesOf = async (store: MessageStore, refs: Iterable<string>): Promise<Map<string, string | null>> => {
  const summaries = await store.refs.summaries([...new Set(refs)])
  return new Map([...summaries].map(([ref, summary]) => [ref, summary.title]))
}

/**
 * The other ends of `edges` that `pick` keeps, each once with all its roles: the usable ones first, then those
 * waiting for the owner, then the ended ones.
 */
export const grouped = (
  edges: Edge[],
  pick: (edge: Edge) => string | undefined,
  names: Map<string, string | null>,
): Related[] => {
  const byRef = new Map<string, Related>()
  for (const edge of edges) {
    const ref = pick(edge)
    if (ref === undefined) continue
    const held = byRef.get(ref) ?? { ref, name: names.get(ref) ?? null, roles: [] }
    held.roles.push(edge.role)
    byRef.set(ref, held)
  }
  const rank = (one: Related) =>
    one.roles.some((role) => isUsable(role.standing))
      ? 0
      : one.roles.some((role) => role.standing === "proposed")
        ? 1
        : 2
  return [...byRef.values()].sort((a, b) => rank(a) - rank(b))
}

export const usable = (edge: Edge): boolean => isUsable(edge.role.standing)

export { CATEGORIES, type Category }

/** The roles that make an organization the owner's employer. */
const EMPLOYED = new Set(["employee", "contractor", "founder"])

/**
 * Each organization's categories, derived from usable relationships in scope and never stored (NEED-2377): `client`
 * is `customer-of` an own organization, `supplier` one an own organization is `customer-of`, `partner` `partner-of`
 * one, `employer` one the owner's person is `member-of` as employee, contractor or founder. Read once per answer.
 */
export const organizationCategories = async (store: MessageStore, scope: Scope): Promise<Map<string, Category[]>> => {
  const found = new Map<string, Set<Category>>()
  const add = (ref: string, category: Category) => found.set(ref, (found.get(ref) ?? new Set()).add(category))
  for (const own of await store.knowledge.ownOrganizations())
    for (const edge of (await edgesOf(store, own.ref, scope)).edges) {
      if (!usable(edge)) continue
      const other = edge.from === own.ref ? edge.to : edge.to === own.ref ? edge.from : undefined
      if (!other?.startsWith("organization:")) continue
      if (edge.role.kind === "customer-of") add(other, edge.to === own.ref ? "client" : "supplier")
      if (edge.role.kind === "partner-of") add(other, "partner")
    }
  const owner = await store.people.owner()
  if (owner)
    for (const edge of (await edgesOf(store, `person:${owner.uid}`, scope)).edges)
      if (
        usable(edge) &&
        edge.role.kind === "member-of" &&
        edge.to.startsWith("organization:") &&
        EMPLOYED.has(edge.role.role ?? "")
      )
        add(edge.to, "employer")
  return new Map([...found].map(([ref, categories]) => [ref, CATEGORIES.filter((one) => categories.has(one))]))
}

/** What `organizations list category:<c>` lists: the organizations of one category, as `organizations` has them. */
export const organizationsInCategory = async (store: MessageStore, category: Category, accounts?: AccountKey[]) => {
  const categories = await organizationCategories(store, scopeOf(accounts))
  return (await store.knowledge.organizations()).filter((one) => categories.get(one.ref)?.includes(category))
}

/**
 * The answer's `coverage`: what was read, each account kept out by the scope, and what each CRM account in scope
 * said its last sync could not read, such as reporting lines with no department list. Named, never filled in.
 */
export const coverageFor = async (store: MessageStore, base: Coverage, scope: Scope): Promise<Coverage> => {
  const read = new Set(base.accounts)
  const notRead = [...base.notRead]
  const named = new Set(notRead.map((one) => one.source))
  for (const key of [...scope.left].sort())
    if (!read.has(key) && !named.has(key)) notRead.push({ source: key, reason: "outside the accounts asked for" })
  for (const key of await store.accounts.accounts())
    if (scope.accounts === undefined || scope.accounts.some((one) => keyOf(one) === keyOf(key)))
      for (const gap of await crmGapsOf(store, key)) notRead.push({ source: keyOf(key), reason: gap.message })
  return { accounts: [...read].sort(), notRead }
}

/** Newest first; one with no date last, in a fixed order. */
export const newestFirst = <T extends { at: string | null; ref: string }>(a: T, b: T): number =>
  (b.at ?? "").localeCompare(a.at ?? "") || a.ref.localeCompare(b.ref)
