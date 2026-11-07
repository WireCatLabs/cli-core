/** Types with a table of their own; anything else a source sends is `custom:<name>` and stays a record only. */
export const RECORD_ENTITY_TYPES = ["invoice", "payment", "person", "organization", "project"] as const

export type RecordEntityType = (typeof RECORD_ENTITY_TYPES)[number]

export interface RecordRoleSpec {
  /** Several relations may carry it; a single role may also be named in `fields.<role>`. */
  many?: boolean
  amount?: boolean
}

export interface RecordTypeSpec {
  table: string
  /** `proposal`: the import proposes the entity and the owner decides; `identity`: only the owner's `map` gives one. */
  review: "proposal" | "identity"
  /** The roles the entity is made from; any other role word is kept as the source's own. */
  roles: Record<string, RecordRoleSpec>
}

export const RECORD_TYPES = {
  invoice: {
    table: "invoices",
    review: "proposal",
    roles: { issuer: {}, counterparty: {}, project: {} },
  },
  payment: {
    table: "payments",
    review: "proposal",
    roles: { payer: {}, payee: {}, project: {}, settles: { many: true, amount: true } },
  },
  person: { table: "persons", review: "identity", roles: {} },
  organization: { table: "organizations", review: "identity", roles: {} },
  project: { table: "projects", review: "identity", roles: {} },
} as const satisfies Record<RecordEntityType, RecordTypeSpec>

export interface StoredTypeSpec {
  table: string
  /**
   * `proposal`: an agent's or an import's row waits for the owner; `valued-proposal`: only while it carries money;
   * `direct`: written as given, it feeds no total.
   */
  review: "proposal" | "valued-proposal" | "direct"
}

/**
 * Typed business entities the envelope does not take yet: they get their refs and the owner's decisions here, and
 * their projectors with the envelope's new types.
 */
export const BUSINESS_TYPES = {
  order: { table: "orders", review: "proposal" },
  product: { table: "catalog_items", review: "direct" },
  contract: { table: "contracts", review: "valued-proposal" },
  subscription: { table: "subscriptions", review: "proposal" },
  wallet: { table: "financial_accounts", review: "direct" },
  transaction: { table: "financial_transactions", review: "proposal" },
} as const satisfies Record<string, StoredTypeSpec>

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
  ...decidedOf(BUSINESS_TYPES),
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
