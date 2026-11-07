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
