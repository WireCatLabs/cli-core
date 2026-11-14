import { type DateRange, dateRange, type Occur, type Predicate, type Span } from "@wirecat/cli-base/query"

/**
 * Where a read looks, the one vocabulary of messages, mail, calendar and meetings: the store (`archive`), the
 * service's own search (`server`), or both, with what the service returns kept in the store.
 */
export const BACKENDS = ["archive", "server", "both"] as const
export type Backend = (typeof BACKENDS)[number]

/** The operators a service's own search may read; patterns and regexes always stay with the store. */
export type ServiceOperator = "term" | "phrase" | "range"

/** A parsed query whose leaves may carry what resolving them found, as messages' `ResolvedNode` does. */
export type QueryTree<P extends Predicate = Predicate> =
  | P
  | { kind: "boolean"; clauses: { occur: Occur; node: QueryTree<P> }[]; span: Span }

/**
 * What a service's search can filter, and how its call is built. `B` is one call's criteria in the caller's terms. The
 * store answers the whole query afterwards, so a part the service cannot read is left out: that only widens a call.
 */
export interface ServiceCapability<P extends Predicate, B> {
  /** The fields the service filters, each with the operators it reads. */
  fields: Readonly<Record<string, readonly ServiceOperator[]>>
  /** The fields whose NOT the service can send; every other NOT is the store's. */
  negatable?: readonly string[]
  /** At most this many calls; the branches beyond it are not asked and the answer is not complete. */
  maxCalls: number
  /** Criteria that match everything: where every call starts, and what a part left out becomes. */
  all: B
  /**
   * One readable leaf as criteria. `undefined` drops the branch it is in: no call can match it (another account's
   * chat). A leaf with nothing to send but that may match returns `all` itself.
   */
  leaf(predicate: P, negated: boolean): B | undefined
  /** Both criteria at once; `undefined` when they cannot both hold, so the branch is never asked. */
  both(one: B, other: B): B | undefined
  /** A service that can OR joins every branch into its one call; without it each OR branch is a call of its own. */
  either?(branches: B[]): B
  /** Whether a branch is worth a call: messages asks only with words. A branch left out does not count as a call. */
  sends?(branch: B): boolean
}

export interface ServiceCalls<B> {
  calls: B[]
  /** False when the cap left a branch unasked. */
  complete: boolean
  /** Branches `sends` refused. */
  unsent: number
}

/** Past this many branches an AND of ORs is not multiplied further: the clause is left to the store. */
const MAX_BRANCHES = 64

// Criteria may be arrays themselves, so a missing one is an empty list and a present one is wrapped.
const some = <B>(value: B | undefined): B[] => (value === undefined ? [] : [value])

const readable = <P extends Predicate, B>(node: P, capability: ServiceCapability<P, B>) =>
  capability.fields[node.field]?.includes(node.operator as ServiceOperator) === true

const branchesOf = <P extends Predicate, B>(
  node: QueryTree<P>,
  capability: ServiceCapability<P, B>,
  cut: { branches: boolean },
): B[] => {
  if (node.kind === "predicate")
    return readable(node, capability) ? some(capability.leaf(node, false)) : [capability.all]
  const must = node.clauses.filter(({ occur }) => occur === "must")
  const not = node.clauses.flatMap(({ occur, node }) =>
    occur === "must_not" &&
    node.kind === "predicate" &&
    capability.negatable?.includes(node.field) &&
    readable(node, capability)
      ? some(capability.leaf(node, true))
      : [],
  )
  const should = node.clauses.filter(({ occur }) => occur === "should")
  // Lucene: beside a required clause an optional one only ranks, so only the required ones narrow.
  const base =
    must.length || !should.length
      ? must.reduce<B[]>(
          (product, { node }) => {
            const next = product.flatMap((one) =>
              branchesOf(node, capability, cut).flatMap((other) => some(capability.both(one, other))),
            )
            // Leaving a required clause out only widens the calls: nothing is lost.
            return next.length > MAX_BRANCHES ? product : next
          },
          [capability.all],
        )
      : should.flatMap(({ node }) => branchesOf(node, capability, cut))
  if (base.length > MAX_BRANCHES) cut.branches = true
  return not.reduce<B[]>(
    (branches, negated) => branches.flatMap((one) => some(capability.both(one, negated))),
    base.slice(0, MAX_BRANCHES),
  )
}

/**
 * Splits a parsed query into the calls a service's search can take: the parts it can read kept, the rest left out,
 * which only widens a call and never loses a hit, since the store answers the whole query after. Each OR branch is a
 * call of its own, up to `maxCalls`, unless the service can OR. `scope` holds in every call (`--chat`).
 */
export const serviceCallsOf = <P extends Predicate, B>(
  root: QueryTree<P>,
  capability: ServiceCapability<P, B>,
  scope?: B,
): ServiceCalls<B> => {
  const cut = { branches: false }
  const all = branchesOf(root, capability, cut).flatMap((branch) =>
    scope === undefined ? [branch] : some(capability.both(scope, branch)),
  )
  const sent = capability.sends ? all.filter((branch) => capability.sends?.(branch)) : all
  const unique = [...new Map(sent.map((branch) => [JSON.stringify(branch), branch])).values()]
  const unsent = all.length - sent.length
  if (capability.either && unique.length) return { calls: [capability.either(unique)], complete: !cut.branches, unsent }
  const max = Math.max(1, capability.maxCalls)
  return { calls: unique.slice(0, max), complete: !cut.branches && unique.length <= max, unsent }
}

/** A time leaf (`date:`, `started_at:`) as the range it names, in `zone`, at `now`. */
export const rangeOf = (node: Predicate, zone: string, now?: number): DateRange =>
  dateRange(
    node.value,
    node.operator === "range" ? (node.upper ?? "*") : node.value,
    node.operator === "range" ? node.lower_inclusive === true : true,
    node.operator === "range" ? node.upper_inclusive === true : true,
    zone,
    node.span,
    now,
  )

/** Inclusive bounds in milliseconds, as a service's window takes them; an open side is left out. */
export const windowOf = ({
  lower,
  upper,
  lower_inclusive,
  upper_inclusive,
}: DateRange): { from?: number; to?: number } => ({
  ...(lower === undefined ? {} : { from: lower_inclusive ? lower : lower + 1 }),
  ...(upper === undefined ? {} : { to: upper_inclusive ? upper : upper - 1 }),
})
