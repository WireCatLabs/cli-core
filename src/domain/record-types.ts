export interface RecordRoleSpec {
  /** Several relations may carry it; a single role may also be named in `fields.<role>`. */
  many?: boolean
  amount?: boolean
}

export interface RecordTypeSpec {
  table: string
  /**
   * `proposal`: an agent's or an import's row waits for the owner; `valued-proposal`: only while it carries money;
   * `direct`: written as given, it feeds no total; `identity`: only the owner's `map` gives one.
   */
  review: "proposal" | "valued-proposal" | "direct" | "identity"
  /** The envelope takes it. The types after v1's five join when they get their projectors. */
  envelope: boolean
  /** A row can be marked gone, so a ref to it may read as deleted. */
  tombstone: boolean
  /** The roles the entity is made from; any other role word is kept as the source's own. */
  roles: Record<string, RecordRoleSpec>
}

/** The one registry of typed entities: refs, tables, the owner's decisions and the envelope read it. */
export const RECORD_TYPES = {
  invoice: {
    table: "invoices",
    review: "proposal",
    envelope: true,
    tombstone: true,
    roles: { issuer: {}, counterparty: {}, project: {} },
  },
  payment: {
    table: "payments",
    review: "proposal",
    envelope: true,
    tombstone: true,
    roles: { payer: {}, payee: {}, project: {}, settles: { many: true, amount: true } },
  },
  person: { table: "persons", review: "identity", envelope: true, tombstone: false, roles: {} },
  organization: { table: "organizations", review: "identity", envelope: true, tombstone: true, roles: {} },
  project: { table: "projects", review: "identity", envelope: true, tombstone: true, roles: {} },
  order: { table: "orders", review: "proposal", envelope: false, tombstone: true, roles: {} },
  product: { table: "catalog_items", review: "direct", envelope: false, tombstone: true, roles: {} },
  contract: { table: "contracts", review: "valued-proposal", envelope: false, tombstone: true, roles: {} },
  subscription: { table: "subscriptions", review: "proposal", envelope: false, tombstone: true, roles: {} },
  wallet: { table: "financial_accounts", review: "direct", envelope: false, tombstone: true, roles: {} },
  transaction: { table: "financial_transactions", review: "proposal", envelope: false, tombstone: true, roles: {} },
  deal: { table: "deals", review: "direct", envelope: false, tombstone: true, roles: {} },
  lead: { table: "leads", review: "direct", envelope: false, tombstone: true, roles: {} },
  pipeline: { table: "pipelines", review: "direct", envelope: false, tombstone: false, roles: {} },
} as const satisfies Record<string, RecordTypeSpec>

export type RecordType = keyof typeof RECORD_TYPES

type Envelope<T> = { [K in keyof T]: T[K] extends { envelope: true } ? K : never }[keyof T]
export type RecordEntityType = Envelope<typeof RECORD_TYPES>

export const isRecordType = (type: string): type is RecordType => Object.hasOwn(RECORD_TYPES, type)

type Identity<T> = { [K in keyof T]: T[K] extends { review: "identity" } ? K : never }[keyof T]
export type BusinessType = Exclude<RecordType, Identity<typeof RECORD_TYPES>>

/** A business record (an invoice, a deal, a wallet): not a person, organization or project. */
export const isBusinessType = (type: string): type is BusinessType =>
  isRecordType(type) && RECORD_TYPES[type].review !== "identity"

/** Types with a table the envelope takes; anything else a source sends is `custom:<name>` and stays a record only. */
export const RECORD_ENTITY_TYPES = (Object.keys(RECORD_TYPES) as RecordType[]).filter(
  (type): type is RecordEntityType => RECORD_TYPES[type].envelope,
)

type Tables<T> = { [K in keyof T]: T[K] extends { table: infer N } ? N : never }

/** Each registered type's table, for the store's polymorphic pointers. */
export const RECORD_TABLES = Object.fromEntries(
  Object.entries(RECORD_TYPES).map(([type, spec]) => [type, spec.table]),
) as Tables<typeof RECORD_TYPES>

type Decided<T> = {
  [K in keyof T as T[K] extends { review: "proposal" | "valued-proposal" } ? K : never]: T[K] extends {
    table: infer N
  }
    ? N
    : never
}

const decidedOf = <T extends Record<string, { table: string; review: string }>>(types: T): Decided<T> =>
  Object.fromEntries(
    Object.entries(types).flatMap(([type, spec]) =>
      spec.review === "proposal" || spec.review === "valued-proposal" ? [[type, spec.table]] : [],
    ),
  ) as Decided<T>

/**
 * Where the owner's decision on each reviewed type is kept. A subscription's price is decided row by row, so it is
 * one of them though it has no ref of its own.
 */
export const DECIDED_TABLES = {
  ...decidedOf(RECORD_TYPES),
  subscription_price: "subscription_prices",
} as const

export type DecidedType = keyof typeof DECIDED_TABLES
export type DecidedTable = (typeof DECIDED_TABLES)[DecidedType]

/** A role word, a source provider, and the name after `custom:`. */
export const WORD_BODY = "[a-z0-9][a-z0-9_-]{0,62}"
export const TYPE_PATTERN = `^(${RECORD_ENTITY_TYPES.join("|")}|custom:${WORD_BODY})$`
export const TYPE_RULE = `a type is one of ${RECORD_ENTITY_TYPES.join(", ")} or custom:<name>`

export const rolesOf = (type: RecordEntityType): [string, RecordRoleSpec][] =>
  Object.entries(RECORD_TYPES[type].roles as Record<string, RecordRoleSpec>)

export const roleNames = (types: readonly RecordEntityType[], keep: (role: RecordRoleSpec) => boolean | undefined) => [
  ...new Set(types.flatMap((type) => rolesOf(type).flatMap(([name, role]) => (keep(role) ? [name] : [])))),
]

export const AMOUNT_ROLES = roleNames(RECORD_ENTITY_TYPES, (role) => role.amount)
