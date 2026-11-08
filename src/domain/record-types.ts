import {
  CATALOG_KINDS,
  CONTRACT_KINDS,
  CONTRACT_STATUSES,
  ORDER_DIRECTIONS,
  SUBSCRIPTION_STATUSES,
  TRANSACTION_STATUSES,
  WALLET_KINDS,
} from "./business.js"
import { DEAL_KINDS, DEAL_STATUSES } from "./deals.js"
import { INVOICE_DIRECTIONS, MONEY_DIRECTIONS } from "./finance.js"
import { ORDER_PURPOSES, ORDER_STATUSES } from "./orders.js"
import {
  currency,
  day,
  decimal,
  type FieldSchema,
  listOf,
  objectOf,
  oneOf,
  signedDecimal,
  text,
} from "./record-fields.js"

export interface RecordRoleSpec {
  /** The record types a relation of this role may point at; a typed ref (`organization:12`) is held to them too. */
  targets: readonly string[]
  many?: boolean
  /** A record of the type is refused without one. */
  required?: boolean
  /** Only `settles` carries a share of the payment. */
  amount?: boolean
  /** A business relationship between entities: the relation may carry `as`, the part the target plays. */
  relationship?: boolean
  /**
   * Kept in `record_relations` only, never read to make the entity, so it never makes a record wait: the
   * relationships an import reports reach `links` with cli-core #2628's follow-up.
   */
  kept?: boolean
  /**
   * A role v1 already had: `fields.<role>` may name a store ref instead of a relation, and its target type is not
   * checked, so every v1 file means what it meant.
   */
  v1?: boolean
  /** The entity's own column or `<name>_type`/`<name>_id` pair this role fills, which an owner's remap repoints. */
  column?: string
}

export interface NestedSpec {
  /** Item keys that name another record of this account by external id, and the type of that record. */
  references?: Record<string, string>
  /** Item keys that name an entity by its ref, and the type it must be. */
  refs?: Record<string, string>
}

export interface RecordTypeSpec {
  table: string
  /**
   * `proposal`: an agent's or an import's row waits for the owner; `valued-proposal`: only while it carries money;
   * `direct`: written as given, it feeds no total; `identity`: matched by a strong identifier or made by the import.
   */
  review: "proposal" | "valued-proposal" | "direct" | "identity"
  /**
   * What a changed record does to its entity: `in-place` updates it, `re-propose` updates a proposal the import made
   * while the owner has not decided it and flags it after, `re-settle` takes a proposed payment's settles again,
   * `flag` leaves the entity and reports it.
   */
  update: "in-place" | "re-propose" | "re-settle" | "flag"
  /** A row can be marked gone, so a ref to it may read as deleted. */
  tombstone: boolean
  /** The type's `fields`: known keys typed, any other key kept as sent. */
  fields: FieldSchema
  /** The roles the entity is made from; any other role word is kept as the source's own. */
  roles: Record<string, RecordRoleSpec>
  /** Lists inside `fields` whose items name products or other records. */
  nested?: Record<string, NestedSpec>
  /** Keys of `fields` that name another record of this account by external id, and its type: a deal's pipeline. */
  references?: Record<string, string>
}

/**
 * A key v1 already took as any JSON: typing it would refuse sheets v1 kept, so a value that does not read is simply
 * no identifier or no name.
 */
const kept = (description: string): FieldSchema => ({ description })

const PARTY = ["person", "organization"] as const
const ORGANIZATION = ["organization"] as const

const lineItem = objectOf({
  description: text("What the line is for; the product's name when left out", 2000),
  quantity: decimal("A decimal, 1 when left out"),
  unit_price: decimal("A decimal in the parent's currency"),
  amount: decimal("A decimal in the parent's currency: quantity × unit price"),
  // Untyped: with options.lines text an invoice line's product is data, whatever v1 sent in it.
  product: { description: "The product record's external id in this account, read with options.lines products" },
  product_ref: { type: "string", pattern: "^product:[1-9][0-9]*$", description: "A product: ref of the store" },
})

const LINES = { references: { product: "product" }, refs: { product_ref: "product" } } as const

const dealFields = (kind: "deal" | "lead") =>
  objectOf(
    {
      title: text(`The ${kind}'s title`, 200),
      pipeline: text("The pipeline record's external id in this account", 512),
      stage: text("The stage's external id in that pipeline", 512),
      status: oneOf(DEAL_STATUSES, "Left out, the stage's outcome says it"),
      amount: decimal("A decimal in currency"),
      currency,
      close_date: day("When it is expected to close"),
      closed_date: day("When it was won or lost"),
      closed_reason: text("Why it was won or lost", 2000),
      url: text("The source's page for it", 2000),
    },
    { required: ["title", "pipeline", "stage"] },
  )

/** The one registry of typed entities: refs, tables, the owner's decisions and the envelope read it. */
export const RECORD_TYPES = {
  invoice: {
    table: "invoices",
    review: "proposal",
    update: "flag",
    tombstone: true,
    fields: objectOf({
      direction: oneOf(INVOICE_DIRECTIONS),
      number: text("The invoice's number", 80),
      currency,
      issue_date: day("The day it was issued"),
      due_date: day("The day it is due"),
      total: decimal("The printed total: refused when it is not the sum of the lines"),
      lines: listOf(lineItem, 500, "The invoice's lines"),
    }),
    roles: {
      issuer: { targets: PARTY, v1: true, column: "issuer" },
      counterparty: { targets: PARTY, v1: true, column: "counterparty" },
      project: { targets: ["project"], v1: true, column: "project_id" },
      contract: { targets: ["contract"], column: "contract_id" },
      subscription: { targets: ["subscription"], column: "subscription_id" },
    },
    nested: { lines: LINES },
  },
  payment: {
    table: "payments",
    review: "proposal",
    update: "re-settle",
    tombstone: true,
    fields: objectOf({
      direction: oneOf(MONEY_DIRECTIONS),
      amount: decimal("A decimal in currency"),
      currency,
      date: day("The day it was paid"),
      reference: text("The payment's reference", 2000),
    }),
    roles: {
      payer: { targets: PARTY, v1: true, column: "payer" },
      payee: { targets: PARTY, v1: true, column: "payee" },
      project: { targets: ["project"], v1: true, column: "project_id" },
      settles: { targets: ["invoice"], many: true, amount: true, v1: true },
      refund_of: { targets: ["payment"], column: "refund_of" },
      subscription: { targets: ["subscription"], column: "subscription_id" },
    },
  },
  person: {
    table: "persons",
    review: "identity",
    update: "in-place",
    tombstone: false,
    fields: objectOf({
      name: kept("The person's name"),
      email: kept("E-mail addresses, one or a list: an exact one links the record to the one person who has it"),
      phone: kept("Phone numbers, one or a list: an exact one, read to E.164, links like an e-mail"),
    }),
    roles: { "member-of": { targets: ORGANIZATION, relationship: true, kept: true } },
  },
  organization: {
    table: "organizations",
    review: "identity",
    update: "in-place",
    tombstone: true,
    fields: objectOf({
      name: kept("The organization's name"),
      identifiers: listOf(
        objectOf(
          {
            scheme: {
              type: "string",
              pattern: "^(email|domain|tax-id:[a-z]{2}|registration:[a-z]{2})$",
              description: "email, domain, tax-id:<country> or registration:<country>",
            },
            value: text("The identifier as the scheme writes it", 320),
          },
          { required: ["scheme", "value"] },
        ),
        20,
        "Strong identifiers: one that another organization has links the record to it",
      ),
    }),
    roles: {
      "customer-of": { targets: ORGANIZATION, relationship: true, kept: true },
      "partner-of": { targets: ORGANIZATION, relationship: true, kept: true },
    },
  },
  project: {
    table: "projects",
    review: "identity",
    update: "in-place",
    tombstone: true,
    fields: objectOf({
      name: kept("The project's name"),
      key: kept("The project's key: an existing project with it is this one"),
      description: kept("What the project is"),
    }),
    roles: { organization: { targets: ORGANIZATION, column: "organization_id" } },
  },
  order: {
    table: "orders",
    review: "proposal",
    update: "re-propose",
    tombstone: true,
    fields: objectOf({
      number: text("The order's number at the supplier", 80),
      direction: oneOf(ORDER_DIRECTIONS, "purchase when left out; in a sale the owner is the supplier"),
      purpose: oneOf(ORDER_PURPOSES, "business when left out"),
      status: oneOf(ORDER_STATUSES, "placed when left out"),
      supplier_name: text("The shop or supplier as the source names it", 200),
      order_date: day("The day it was ordered"),
      fulfilled_date: day("The day it was delivered"),
      currency,
      total: decimal("With lines, their sum"),
      source_url: text("The order's page at the shop", 2000),
      lines: listOf(lineItem, 500, "The order's lines"),
    }),
    roles: {
      customer: { targets: PARTY, column: "customer" },
      supplier: { targets: PARTY, column: "supplier" },
      project: { targets: ["project"], column: "project_id" },
      contract: { targets: ["contract"], column: "contract_id" },
      deal: { targets: ["deal"], column: "deal_id" },
      invoice: { targets: ["invoice"], column: "invoice_id" },
      payment: { targets: ["payment"], column: "payment_id" },
    },
    nested: { lines: LINES },
  },
  product: {
    table: "catalog_items",
    review: "direct",
    update: "in-place",
    tombstone: true,
    fields: objectOf(
      {
        kind: oneOf(CATALOG_KINDS, "product when left out"),
        name: text("The product's name", 200),
        sku: text("The supplier's code for it", 80),
        unit: text("hour, pcs, month: free text", 40),
        unit_price: decimal("A decimal in currency"),
        currency,
        description: text("What it is", 2000),
        archived_date: day("No longer sold from this day"),
      },
      { required: ["name"] },
    ),
    roles: { supplier: { targets: PARTY, column: "supplier" } },
  },
  contract: {
    table: "contracts",
    review: "valued-proposal",
    update: "re-propose",
    tombstone: true,
    fields: objectOf(
      {
        name: text("The contract's name", 200),
        number: text("The contract's number", 80),
        kind: oneOf(CONTRACT_KINDS),
        status: oneOf(CONTRACT_STATUSES, "active when left out"),
        signed_date: day("The day it was signed"),
        effective_date: day("The day it starts"),
        expiration_date: day("The day it ends; open-ended when left out"),
        auto_renew: { type: "boolean", description: "Whether it renews itself" },
        renewal: { type: "string", pattern: "^[1-9][0-9]{0,2}-(day|week|month|year)$", description: "1-year" },
        notice_days: { type: "integer", minimum: 0, maximum: 3650, description: "Days of notice before it ends" },
        terms: text("Renewal, cancellation and other terms, as text", 20_000),
        value: decimal("A decimal in currency: the contract is then a proposal"),
        currency,
      },
      { required: ["name", "kind"] },
    ),
    roles: {
      project: { targets: ["project"], column: "project_id" },
      deal: { targets: ["deal"], column: "deal_id" },
      party: { targets: PARTY, many: true, relationship: true, kept: true },
      document: { targets: ["document"], many: true, kept: true },
    },
  },
  subscription: {
    table: "subscriptions",
    review: "proposal",
    update: "re-propose",
    tombstone: true,
    fields: objectOf(
      {
        name: text("Its name; the product's when left out", 200),
        direction: oneOf(INVOICE_DIRECTIONS, "receivable: the owner bills it; payable: the owner pays it"),
        status: oneOf(SUBSCRIPTION_STATUSES),
        interval: { type: "string", pattern: "^[1-9][0-9]{0,2}-(day|week|month|year)$", description: "1-month" },
        start_date: day("The first day"),
        trial_end_date: day("The trial's last day"),
        next_renewal_date: day("The next renewal"),
        cancelled_date: day("The day it was cancelled"),
        end_date: day("The last day"),
        prices: listOf(
          objectOf(
            {
              amount: decimal("A decimal in currency"),
              currency,
              effective_from: day("The day the price starts; the subscription's start when left out"),
            },
            { required: ["amount", "currency"] },
          ),
          100,
          "Its prices, each from a day; a price is never overwritten",
        ),
      },
      { required: ["direction", "interval", "start_date"] },
    ),
    roles: {
      supplier: { targets: PARTY, column: "supplier" },
      customer: { targets: PARTY, column: "customer" },
      product: { targets: ["product"], column: "catalog_item_id" },
      contract: { targets: ["contract"], column: "contract_id" },
      project: { targets: ["project"], column: "project_id" },
    },
  },
  wallet: {
    table: "financial_accounts",
    review: "direct",
    update: "in-place",
    tombstone: true,
    fields: objectOf(
      {
        name: text("The account's name", 200),
        kind: oneOf(WALLET_KINDS, "bank when left out"),
        currency,
        institution: text("The bank, as text", 200),
        number_hint: text("The last 4 characters of its number; a whole IBAN or card number is refused", 4),
        opening_balance: signedDecimal("Kept in the record only: the owner sets the wallet's opening balance"),
        opening_date: day("The day of that balance"),
      },
      { required: ["name", "currency"] },
    ),
    roles: { holder: { targets: PARTY, column: "holder" } },
  },
  transaction: {
    table: "financial_transactions",
    review: "proposal",
    update: "re-propose",
    tombstone: true,
    fields: objectOf(
      {
        direction: oneOf(MONEY_DIRECTIONS),
        amount: decimal("A decimal above 0 in the wallet's currency"),
        currency,
        status: oneOf(TRANSACTION_STATUSES, "booked when left out"),
        date: day("The day the statement shows"),
        booked_date: day("The day it was booked; the statement day when left out"),
        description: text("As the statement says it", 2000),
        counterparty_name: text("As the statement names the other side", 200),
        reference: text("The statement's reference", 200),
        splits: listOf(
          objectOf(
            {
              amount: decimal("A decimal above 0"),
              category: text("Free text, such as rent", 200),
              note: text("A note", 2000),
            },
            { required: ["amount", "category"] },
          ),
          100,
          "Categories of its amount; what they leave is uncategorized",
        ),
      },
      { required: ["direction", "amount", "date"] },
    ),
    roles: {
      wallet: { targets: ["wallet"], required: true, column: "financial_account_id" },
      counterparty: { targets: PARTY, column: "counterparty" },
      payment: { targets: ["payment"], column: "payment_id" },
      project: { targets: ["project"], column: "project_id" },
    },
  },
  deal: {
    table: "deals",
    review: "direct",
    update: "in-place",
    tombstone: true,
    fields: dealFields("deal"),
    references: { pipeline: "pipeline" },
    roles: {
      organization: { targets: ORGANIZATION, column: "organization_id" },
      person: { targets: ["person"], many: true, relationship: true },
      project: { targets: ["project"], column: "project_id" },
    },
  },
  lead: {
    table: "leads",
    review: "direct",
    update: "in-place",
    tombstone: true,
    fields: dealFields("lead"),
    references: { pipeline: "pipeline" },
    roles: {
      organization: { targets: ORGANIZATION, column: "organization_id" },
      person: { targets: ["person"], many: true, relationship: true },
      project: { targets: ["project"], column: "project_id" },
      deal: { targets: ["deal"], column: "deal_id" },
    },
  },
  pipeline: {
    table: "pipelines",
    review: "direct",
    update: "in-place",
    tombstone: false,
    fields: objectOf(
      {
        kind: oneOf(DEAL_KINDS, "deal when left out"),
        name: text("The pipeline's name", 80),
        stages: listOf(
          objectOf(
            {
              external_id: text("The stage's id at the source", 512),
              name: text("The stage's name", 80),
              position: { type: "integer", minimum: 0, maximum: 1000 },
              outcome: oneOf(DEAL_STATUSES, "open when left out"),
            },
            { required: ["external_id", "name"] },
          ),
          30,
          "The stages in order",
        ),
      },
      { required: ["name", "stages"] },
    ),
    roles: {},
  },
} as const satisfies Record<string, RecordTypeSpec>

export type RecordType = keyof typeof RECORD_TYPES

/** Every registered type is an envelope type: `custom:<name>` covers whatever a source has beyond them. */
export type RecordEntityType = RecordType

export const isRecordType = (type: string): type is RecordType => Object.hasOwn(RECORD_TYPES, type)

type Identity<T> = { [K in keyof T]: T[K] extends { review: "identity" } ? K : never }[keyof T]
export type IdentityType = Identity<typeof RECORD_TYPES>
export type BusinessType = Exclude<RecordType, IdentityType>

/** A business record (an invoice, a deal, a wallet): not a person, organization or project. */
export const isBusinessType = (type: string): type is BusinessType =>
  isRecordType(type) && RECORD_TYPES[type].review !== "identity"

export const isIdentityType = (type: unknown): type is IdentityType =>
  typeof type === "string" && isRecordType(type) && RECORD_TYPES[type].review === "identity"

export const RECORD_ENTITY_TYPES = Object.keys(RECORD_TYPES) as RecordType[]

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

export const rolesOf = (type: RecordType): [string, RecordRoleSpec][] =>
  Object.entries(RECORD_TYPES[type].roles as Record<string, RecordRoleSpec>)

export const roleOf = (type: string, role: string): RecordRoleSpec | undefined =>
  isRecordType(type) ? (RECORD_TYPES[type].roles as Record<string, RecordRoleSpec>)[role] : undefined

export const nestedOf = (type: RecordType): [string, NestedSpec][] =>
  Object.entries((RECORD_TYPES[type] as RecordTypeSpec).nested ?? {})

export const referencesOf = (type: RecordType): [string, string][] =>
  Object.entries((RECORD_TYPES[type] as RecordTypeSpec).references ?? {})

export const roleNames = (types: readonly RecordType[], keep: (role: RecordRoleSpec) => boolean | undefined) => [
  ...new Set(types.flatMap((type) => rolesOf(type).flatMap(([name, role]) => (keep(role) ? [name] : [])))),
]

export const AMOUNT_ROLES = roleNames(RECORD_ENTITY_TYPES, (role) => role.amount)
