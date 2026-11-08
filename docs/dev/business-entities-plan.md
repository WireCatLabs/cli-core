# Plan — business data: commercial and bank entities, one import path

For the developer and agent who build it. The user-facing pages come later (§ Docs). This file is the design and the
build order; it is deleted when the work is merged.

Status: **building, 2026-11-08.** PRs 1 and 2 are merged (#2656, #2634). PR 3 (#2649), PR 4 (#2660), the phone
records (#2661), PR 5 (#2668) and PR 6 (the search lane and the docs) are open, each on the one before. Owner rulings of 2026-11-07 are binding and are listed in § Rulings, including the
answers to the three questions this plan raised. Code comments in this work follow the repository rule: sparse, and only *why*.

## Why

The store holds invoices, payments, orders, deals and leads, but not the rest of a small business: what it sells, the
contracts it works under, the subscriptions it pays or bills, the lines of an order, and the bank accounts the money
moves through. A source that has these (an ERP, a CRM, a bank statement, a spreadsheet) can send only invoices,
payments, people, organizations and projects today. Everything else becomes an opaque `custom:` record, or nothing.
This plan adds the missing typed tables, keeps one import path (the records envelope) for all of them, and lets an
agent answer "what does this customer owe, under which contract, for which products, and did the bank see it" with
refs and without guessing.

## Rulings

1. Financial accounts, transactions and splits are built now, in full.
2. A person, organization or project record with no mapping **creates** an entity, marked as made by the import.
   Nothing is matched by name. A strong identifier that matches exactly one entity links to it; for a person that is
   an exact e-mail or an exact phone number (owner, 2026-11-07). Two or more matches: nothing is created; the record
   waits for the owner. This applies to every file, v1 files included (owner, 2026-11-07): no opt-in option. Remapping stays the owner's (`records link`); an agent may only propose.
3. Anything an import or an agent writes that feeds money totals is a **proposal**: invoices, payments, orders with
   lines, contracts with a value, subscriptions and their prices, financial transactions and their splits. Written
   directly: catalog items, deals, leads, pipelines, `custom:*` records, financial accounts. The owner's own CLI entry
   is confirmed at once. An import never writes confirmed money.
4. Deals and leads stay as they are; no "opportunity" model. Orders are reused and get `order_lines`. One
   `catalog_items` table with `kind` product or service. A line copies the price; a catalog price change never
   changes a line. Both line tables get a nullable `catalog_item_id`.
5. All new tables in **one migration, version 57** (version 56 is taken by #2628). Additive; replacing a trigger is
   allowed. `minCompatible` stays 34.
6. A refund is a payment of the other direction with `refund_of` → the original payment.
7. Bank model: a transaction is what the statement says moved; a payment is the settlement between parties; an
   allocation joins a payment to an invoice. Splits categorize a transaction. A balance is computed, never stored.
   No general ledger, no double entry, no FX.
8. Contracts: name, kind, status, dates, renewal and cancellation terms, optional value, project; parties with a
   role. Documents are `attached` links.
9. Subscriptions: supplier and customer, catalog item, contract, status, interval, dates; price history in
   `subscription_prices`, never overwritten.
10. Structural relations between business records (contract ↔ order or invoice, invoice or payment ↔ subscription,
    line → catalog item, refund → payment, transaction → payment) are typed foreign keys or `record_relations`, never
    `links`. Business relationships between entities (parties, members, people on a deal) are `links` written
    through `store.relations.syncReported` (§ Dependencies).
11. Money: integer minor units with `CURRENCY_SCALES`, decimal strings in and out, explicit currency, totals per
    currency.
12. The envelope v1 is extended compatibly: every v1 file stays valid and behaves the same, except ruling 2: a person,
    organization or project record that waited for `records link` is now matched or created on its next import. That
    goes under "Changed — may break callers". JSONL streams.
13. Financial accounts are `wallets` in commands and `wallet:<id>` as refs.

## Current state

Anchors on `origin/main` 9386f1765, package 0.602.0, store version 55.

- **Tables that exist.** `invoices`, `invoice_lines`, `payments`, `payment_allocations` (v45), `records`,
  `record_relations` (v47, amounts v49), `orders` without lines (v50), `pipelines`, `pipeline_stages`, `deals`,
  `leads` (v52–54) — `src/store/sqlite/schema.ts:1790-2154`. None for contracts, subscriptions, catalog items, order
  lines, financial accounts, transactions or splits.
- **Money rules** are in code (`src/store/sqlite/finance.ts:499-620`) and again in triggers
  (`drizzle/20261102173113_version-45-finance-rules/migration.sql`). Paid is the sum of confirmed allocations
  (`PAID`, `finance.ts:285`); `settledStatus` derives `issued`, `partly_paid`, `paid` from it
  (`src/domain/finance.ts:16`). No refunds: a refund is an unrelated `out` payment.
- **Review.** `review` proposed|confirmed|rejected on invoices, payments, orders. `decide()` accepts only invoice and
  payment (`finance.ts:568`); `keepDecision`'s table list is fixed (`finance.ts:355`); orders have their own
  confirm (`src/store/sqlite/orders.ts:84`).
- **Envelope v1** (`src/domain/records.ts`). Types are a fixed list (`:7`) and a regex that repeats it (`:54`); an
  unknown type is refused (`record.type`). Only invoice and payment are projected (`PROJECTED`,
  `src/store/sqlite/records.ts:94`), also as SQL literals (`:323`, `:593`). Person, organization and project get an
  entity only through the owner's `map` (`records.ts:601`). `fields` is any object (`records.ts:84`): unknown keys are
  kept.
- **CRM sync** writes deals and leads by `(account_id, external_id)` (`src/store/sqlite/crm.ts:273`), creates an
  organization for an unmapped company record (`crm.ts:418-476`), and resolves people through identities
  `<account>/contact/<id>` (`crmIdentityId`, `crm.ts:75`). It does not use the envelope.
- **Strong identifiers.** People: `identities` with `provider = 'email'`, or `identities.email` (CRM contacts), joined
  through `identity_links` (`schema.ts:135-175`). **Organizations have no tax id, registration number or domain
  column** (`schema.ts:271`); their only identifiers are e-mail identities in `organization_identities`
  (`schema.ts:293`). Mail findings match a company domain by e-mail suffix minus free-mail domains
  (`src/store/sqlite/mail-findings.ts:173-177`); that is a heuristic, not a strong identifier. Projects: `key`,
  unique.
- **JSONL is not streamed.** `envelopeOfJsonl` splits a whole string (`records.ts:295`); memo reads the whole file
  first (`cli-memo src/records/import.ts:11-25`). `ingest` keeps every record, key and outcome in arrays
  (`src/services/ingest.ts:66-97`, `records.ts:471-524`).
- **Refs** are one lower-case word before the colon (`looksLikeReference`, `src/domain/references.ts:219`), so a
  prefix takes no hyphen or underscore.
- **Search** has a `crm` lane that folds deal and lead titles in memory (`src/store/sqlite/deals.ts:676-705`,
  `src/services/search-all.ts:366`); no lane reads invoices, payments, orders or records.
- **Trigger replacement precedent:** `drizzle/20261025071850_version-32-files-data/migration.sql:25` and
  `drizzle/20261101002523_version-42-task-revision/migration.sql:3` use `DROP TRIGGER`.

## Dependencies

| What | State | Used for |
| --- | --- | --- |
| cli-core #2628, store version 56 | reservation PR open | `links.account_id` (`<provider>:<account>`), `starts_at`/`ends_at`, `deleted_at` (source stopped reporting), `link_revisions`, unique (from, to, kind, role, account_id) on relationship links |
| `src/domain/relations.ts` (kinds, endpoints, roles) | comes with #2628's build | contract parties, people on deals, member-of from an import |
| `store.relations.syncReported(accountKey, relationships[])` | working name, signature later | every relationship an import reports |
| Memory workstream D1: person separation guard in `joinByAddress`/`linkOwnIdentities` | PR in progress, function name later | identifier matching must not rejoin two people the owner separated |
| Memory workstream D5: one shared identity matcher | last in their order | the import's lookup lives in one self-contained function so D5 can move it unchanged |

Everything in this plan that writes `links` **depends on #2628 and its follow-up, to confirm with its author.** The
rest (tables, money rules, envelope, streaming) does not, and is built first.

## Domain model

### Shared rules for every new table

- Times are epoch ms; days are `YYYY-MM-DD` text, as on invoices.
- Money is an integer in minor units with a `currency` beside it; amount and currency are both set or both null.
- Polymorphic parties are `<name>_type` + `<name>_id`, `type` in person or organization; each new type joins
  `ENTITY_TABLES` (`src/store/sqlite/entity-types.ts:7`).
- Review-bearing tables carry the invoice set: `review`, `author_type`/`author_id`, `model`,
  `confirmed_by_type`/`confirmed_by_id`, `source` (`owner`, `agent`, `import:<provider>`), `metadata` (reason,
  decision), `deleted_at`.
- Direct tables carry `author_type`/`author_id`, `source`, `metadata`, `deleted_at`.
- No `account_id`/`external_id` on the new tables: the route back to the source is `records.entity_type/entity_id`,
  as for invoices and payments. Deals and leads keep theirs, because CRM sync writes them without records.

### Names

| Table | Entity type and ref | Envelope type | memo group | Why this name |
| --- | --- | --- | --- | --- |
| `catalog_items` | `product`, `product:<id>` | `product` | `products` | `catalog` is taken (file catalogue, `src/store/sqlite/catalog.ts`; cli-base singular). `products` is already a cli-base noun. A service is a product here, as in Stripe's Product |
| `contracts` | `contract` | `contract` | `contracts` | module `business-contracts.ts`: `src/cli/command-contract.ts` owns the word |
| `subscriptions`, `subscription_prices` | `subscription` | `subscription` | `subscriptions` | — |
| `order_lines` | no ref (part of its order) | nested in `order` | `orders lines` | — |
| `financial_accounts` | `wallet`, `wallet:<id>` | `wallet` | `wallets` | `account` is integration accounts (table, ref, cli-base singular, `--account` scope flag). Owner chose `wallets` |
| `financial_transactions`, `transaction_splits` | `transaction`, `transaction:<id>` | `transaction` | `transactions`, `transactions splits` | module `money-transactions.ts`: `src/store/sqlite/transaction.ts` is the SQLite helper |

### Changed existing tables (additive columns)

| Table | New column | Type, constraint | Why |
| --- | --- | --- | --- |
| `payments` | `refund_of` | int null → `payments.id` | ruling 6 |
| `payments` | `subscription_id` | int null → `subscriptions.id` | a card charge with no invoice still belongs to its subscription |
| `invoices` | `contract_id` | int null → `contracts.id` | structural, one contract per invoice |
| `invoices` | `subscription_id` | int null → `subscriptions.id` | the period it bills |
| `invoice_lines` | `catalog_item_id` | int null → `catalog_items.id` | ruling 4 |
| `orders` | `contract_id` | int null → `contracts.id` | structural |
| `orders` | `deal_id` | int null → `deals.id` | the deal it came from, when no contract sits between |
| `orders` | `direction` | text not null default `purchase` | `purchase` (today's orders: the owner buys) or `sale` (the owner sells) |
| `record_relations` | `as_role` | text null | the role inside a relationship (`decision-maker`, `customer`); null on every v1 row |
| `records` | `created_entity` | int not null default 0 | 1 when this record created its entity: "marked as from import" (persons have no column for it) |
| `records` | index `(account_id, batch_id)` | — | the end-of-stream waiting and flagged queries |

An invoice or order under more than one contract is not modelled: none of the sources in view has one.

### `catalog_items` — direct

| Column | Type | Constraint |
| --- | --- | --- |
| `kind` | text | `product` or `service` |
| `name`, `name_folded` | text | not null |
| `sku` | text null | unique per supplier among live rows |
| `supplier_type`, `supplier_id` | null | null = the owner's own item |
| `unit` | text null | `hour`, `pcs`, … free text |
| `unit_price`, `currency` | int null, text null | both or neither; ≥ 0 |
| `description` | text null | |
| `archived_date` | text null | no longer sold; lines and subscriptions keep pointing at it |
| audit, `deleted_at` | | |

Triggers `catalog_items_valid_bi/bu`: kind, price ≥ 0, price and currency together. Changing `unit_price` touches no
line: lines hold their own copy.

### `order_lines` — part of its order, shares its review

| Column | Type | Constraint |
| --- | --- | --- |
| `order_id` | int | not null → `orders.id` |
| `position` | int | unique `(order_id, position)` |
| `description` | text | not null; copied from the item when not given |
| `quantity` | text | decimal, ≤ 3 places (`quantityOf`, `src/domain/money.ts:115`) |
| `unit_price` | int null | copied, never read back from the item |
| `amount` | int | quantity × unit price, rounded half up (`lineUnits`, `money.ts:124`) |
| `catalog_item_id` | int null | → `catalog_items.id` |

Orders today are the owner buying from a shop (`supplier_name` not null, `src/domain/orders.ts:4-6`). A **sale**
order (`direction = 'sale'`) has the owner as supplier: `supplier_type/id` is the owner's person (`persons.owner = 1`)
unless the source names the owner's organization, `supplier_name` is that party's name, and `purpose` is `business`.

Rules: an order with lines has a currency and a total equal to their sum (`order.total`, code and
`orders_valid_bu`); an order without lines keeps today's rule (both or neither). Lines change only while the order is
proposed (its author or the owner) or by the owner.

### `contracts` — proposal when it has a value, else direct

| Column | Type | Constraint |
| --- | --- | --- |
| `name` | text | not null |
| `number` | text null | |
| `kind` | text | `sale`, `purchase`, `service`, `lease`, `employment`, `nda`, `license`, `other` |
| `status` | text | `draft`, `active`, `ended`, `terminated` |
| `signed_date`, `effective_date`, `expiration_date` | text null | expiration null = open-ended; effective ≤ expiration |
| `auto_renew` | int | 0 or 1, default 0 |
| `renewal_count`, `renewal_unit` | int null, text null | both or neither; unit `day`, `week`, `month`, `year` |
| `notice_days` | int null | ≥ 0; the notice deadline is computed (`expiration_date − notice_days`), never stored |
| `terms` | text null | free text: renewal, cancellation, anything else |
| `value`, `currency` | int null, text null | both or neither; ≥ 0 |
| `project_id` | int null | → `projects.id` |
| `deal_id` | int null | → `deals.id`: the deal it closed |
| review set, audit, `deleted_at` | | |

Review: a contract with no value is written `confirmed` by anyone (it feeds no total). With a value, an import's or
an agent's contract is `proposed`. Setting or changing the value of a confirmed contract is the owner's only
(`finance.owner-only`). Parties are relationships (§ Relationship rules); the document is an `attached` link.

### `subscriptions` — proposal

| Column | Type | Constraint |
| --- | --- | --- |
| `name` | text | not null; defaults to the item's name |
| `direction` | text | `receivable` (the owner bills) or `payable` (the owner pays), as on invoices |
| `supplier_type`, `supplier_id` | | not null |
| `customer_type`, `customer_id` | | not null |
| `catalog_item_id` | int null | → `catalog_items.id` |
| `contract_id` | int null | → `contracts.id` |
| `project_id` | int null | |
| `status` | text | `trial`, `active`, `paused`, `cancelled`, `ended` |
| `interval_count`, `interval_unit` | int, text | count ≥ 1; unit `day`, `week`, `month`, `year` |
| `start_date` | text | not null |
| `trial_end_date`, `next_renewal_date`, `cancelled_date`, `end_date` | text null | trial end ≥ start; status `trial` needs a trial end; `cancelled` needs a cancelled date |
| review set, audit, `deleted_at` | | |

Supplier and customer are columns, not relationships: a subscription has exactly one of each, as an invoice has one
counterparty. Contract parties are N-valued with roles, which is what relationships are for.

### `subscription_prices` — proposal per row, never overwritten

| Column | Type | Constraint |
| --- | --- | --- |
| `subscription_id` | int | not null |
| `amount`, `currency` | int, text | not null; amount ≥ 0 |
| `effective_from` | text | not null; unique `(subscription_id, effective_from)` among rows not rejected |
| review set (no `deleted_at`) | | |

Trigger `subscription_prices_fixed_bu` refuses a change of amount, currency or effective_from; only `review`,
`confirmed_by_*`, `metadata`, `updated_at` change. A correction is a rejection plus a new row. The current price is
the confirmed row with the latest `effective_from` ≤ today. A new price on a confirmed subscription from an import or
agent is a proposal of its own; the subscription stays confirmed.

### `financial_accounts` (`wallet:`) — direct, opening balance owner-only

| Column | Type | Constraint |
| --- | --- | --- |
| `name`, `name_folded` | text | not null |
| `kind` | text | `bank`, `card`, `cash`, `wallet`, `other` |
| `currency` | text | not null; one currency per account — a multi-currency bank account is one row per currency |
| `institution` | text null | the bank's name as text |
| `number_hint` | text null | last 4 characters only; a full IBAN or card number is refused (`wallet.number`) |
| `holder_type`, `holder_id` | null | whose account, when not the owner |
| `opening_balance`, `opening_date` | int null, text null | both or neither; signed; written by the owner only |
| `closed_date` | text null | |
| audit, `deleted_at` | | |

Direct because the row itself holds no money that counts: a balance is the sum of confirmed transactions. The one
column that does count, `opening_balance`, is the owner's: an import's value stays in the record's fields and
`wallets show` prints it as "the source says" until the owner sets it.

### `financial_transactions` (`transaction:`) — proposal

| Column | Type | Constraint |
| --- | --- | --- |
| `financial_account_id` | int | not null |
| `direction` | text | `in` or `out` |
| `amount` | int | > 0 |
| `currency` | text | equals the account's |
| `status` | text | `pending` or `booked` |
| `date` | text | not null: the day the statement shows |
| `booked_date` | text null | required when booked, null when pending |
| `description` | text null | as the statement says it |
| `counterparty_name` | text null | as the statement says it |
| `counterparty_type`, `counterparty_id` | null | the party, once known |
| `reference` | text null | |
| `payment_id` | int null | → `payments.id`, unique among live rows |
| review set, audit, `deleted_at` | | |

### `transaction_splits` — part of its transaction, shares its review

| Column | Type | Constraint |
| --- | --- | --- |
| `transaction_id` | int | not null |
| `position` | int | unique `(transaction_id, position)` |
| `category`, `category_folded` | text | not null; free text, no category table |
| `amount` | int | > 0; Σ splits ≤ the transaction's amount; the rest is uncategorized |
| `project_id` | int null | |
| `note` | text null | |

### New and replaced triggers (one `--custom` folder, `version-57-business-rules`)

| Trigger | New or replaced | Rule |
| --- | --- | --- |
| `catalog_items_valid_bi/bu` | new | § catalog_items |
| `order_lines_valid_bi/bu` | new | amount, unit price ≥ 0 |
| `orders_valid_bu` | replaced (v50) | adds: with lines, total = Σ lines and currency set |
| `contracts_valid_bi/bu` | new | kind, status, review enums; dates ordered; value and currency together |
| `subscriptions_valid_bi/bu` | new | enums, interval, date rules |
| `subscription_prices_valid_bi`, `_fixed_bu` | new | amount ≥ 0; immutable money columns |
| `financial_accounts_valid_bi/bu` | new | kind; opening balance and date together; no currency change once a transaction exists |
| `financial_transactions_valid_bi/bu` | new | enums; currency = account's; booked needs booked_date; with `payment_id`: same currency, direction and amount as the payment |
| `transaction_splits_valid_bi/bu` | new | amount > 0; Σ ≤ transaction amount |
| `payments_refund_bi/bu` | new | § Refunds |
| `invoices_valid_bu` | replaced (v45) | total ≥ net confirmed paid (was: gross) |
| `payments_confirm_bu` | replaced (v45) | net, and a refund only after its original is confirmed |
| `payment_allocations_valid_bi/bu` | replaced (v45) | signed invoice limit, refund limits |

Each replacement is `DROP TRIGGER` then `CREATE TRIGGER` in the same migration, as v32 and v42 did. The code checks
stay first and give the reason; the triggers catch a stray write.

## Finance correctness rules

### Paid is net

`PAID` (`finance.ts:285`) becomes the confirmed allocations of ordinary payments **minus** the confirmed allocations
of refunds:

```sql
(SELECT coalesce(sum(CASE WHEN p.refund_of IS NULL THEN a.amount ELSE -a.amount END), 0)
   FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
  WHERE a.invoice_id = i.id AND p.review = 'confirmed' AND p.deleted_at IS NULL)
```

The same change in code, so code and triggers agree: the `toInvoice` sum in `allocateRow` (`finance.ts:523`),
`coveredElsewhere` (`finance.ts:549`), `freeOn` (`src/store/sqlite/records.ts:239`), the void check, and
`openTotals` (`finance.ts:915`). One SQL fragment serves all of them.

`settledStatus` keeps its signature: paid ≤ 0 → `issued`, below total → `partly_paid`, else `paid`. **A fully
refunded invoice is `issued` again**: it is still owed unless the owner voids it. Void is allowed when net paid is 0
(today: when no confirmed allocation exists). `openTotals` and `projects status` read the same net figure.

### Refunds

A refund R of payment P:

1. `R.refund_of = P`, `R.direction ≠ P.direction`, same currency; P is not itself a refund, not rejected, not
   deleted (`finance.refund`).
2. Σ amounts of P's refunds that are confirmed, plus R, ≤ P.amount (`finance.over-refund`). Proposed refunds do not
   block the owner, as with allocations.
3. R may be confirmed only after P is confirmed. P may not be rejected or deleted while it has a refund that is not
   rejected (`finance.refunded`).
4. R may be allocated only to an invoice P is allocated to. Σ allocations to invoice I of P's refunds ≤ P's allocation
   to I (`finance.over-refund`). So net paid never goes below 0 for any payment, and the invoice can be paid again
   after a refund.
5. An ordinary payment's allocation to I counts against `I.total − net paid` (counting confirmed payments plus this
   one, as today). A refund's allocation never hits the invoice limit.
6. A refund with no allocation is allowed: a refunded advance.

Trigger changes, exactly:

- `payment_allocations_valid_bi/bu`: the invoice-limit sum becomes the signed sum above (with "or this payment"
  kept); the limit is checked only when the new allocation's payment has `refund_of IS NULL`; for a refund, add
  rule 4 as a second `OR` branch.
- `payments_confirm_bu`: the "other confirmed" sum becomes signed; a refund is refused when its original is not
  confirmed.
- `invoices_valid_bu`: the "total ≥ allocated" sum becomes signed.
- `payments_refund_bi/bu`: rules 1 and 2.
- `payments_valid_bu` and `invoice_lines_valid_*` stay.

### Bank

- A transaction is the statement; a payment is the settlement. They meet only through `financial_transactions.payment_id`.
  A payment without a transaction (cash) and a transaction without a payment (a fee, a transfer between own
  accounts) are both normal.
- Linking: same currency, same direction, equal amount, one transaction per payment. A bank fee is its own transaction.
  A transfer between two own accounts is two transactions, no payment.
- Balance of a wallet on day D = `opening_balance` + Σ `in` − Σ `out` of its transactions that are confirmed, booked,
  not deleted, with `opening_date` < `booked_date` ≤ D. Pending and proposed ones are shown beside it, never in it.
  Computed by the query each time; no stored running balance.
- Splits: totals per category and currency over confirmed, booked transactions. The remainder is "uncategorized".
- No conversion: a report over several wallets gives one total per currency.

### Who may change what

| Write | Owner at a terminal | Agent or MCP | Import |
| --- | --- | --- | --- |
| invoice, payment, refund, order, contract with value, subscription, price, transaction | confirmed | proposed | proposed |
| lines, allocations, splits | yes | only on its own still-proposed parent | only on its own still-proposed parent |
| confirm, reject | yes | no (`finance.owner-only`) | no |
| wallet opening balance | yes | no | kept in the record only |
| product, deal, lead, pipeline, contract without value, wallet, `custom:*` | direct | direct | direct |

## Relationship rules

| Relation | Stored as | Why |
| --- | --- | --- |
| line → order or invoice, split → transaction, price → subscription, stage → pipeline | not-null FK | part of the parent |
| line → catalog item, order/invoice → contract, contract/order → deal, invoice/payment → subscription, subscription → contract and item, transaction → payment and wallet, refund → payment | nullable FK | structural, one target, the store's rules read it |
| allocation (payment → invoice) | `payment_allocations` | an amount on the edge |
| subscription supplier and customer, invoice counterparty, order customer | `_type/_id` columns | exactly one, a money rule reads it |
| contract parties (role `customer`, `supplier`, `signatory`, `guarantor`, `other`) | relationship `related-to` from the contract, via `syncReported` | N-valued with roles; the deal-roles pattern. **Depends on #2628 follow-up**: the contract endpoints and roles join `src/domain/relations.ts` |
| people on a deal or lead (owner, contact, decision-maker) | relationship `related-to` | today's CRM rows, moving to `syncReported` with #2628 |
| person member-of organization, organization customer-of organization | relationship via `syncReported` | **depends on #2628** |
| contract → its document, any entity → its evidence | `links` `attached` / `evidence` | loose; documents are not business records |
| a source's own relation with no canonical meaning (`quoted-in`, `parent-ticket`) | `record_relations` with the source's role word | kept as the source said; resolved record to record within the account |

No new link kind. A relationship an import reports carries `account_id = <provider>:<account>`; deleting the record
withdraws it (`links.deleted_at`), and the owner's own link of the same pair wins (#2628's rules).

## Source records and canonical entities

### One type registry

`src/domain/record-types.ts` replaces `RECORD_ENTITY_TYPES`, the `TYPE` regex, `PROJECTED`, `REFERENCE_FIELDS` and
the `'invoice','payment'` SQL literals. One entry per type:

```ts
interface RecordTypeSpec {
  type: string                      // envelope type, entity type and ref prefix
  table: string
  fields: JsonSchema                // known keys typed; additionalProperties: true
  review: "proposal" | "direct" | "valued-proposal" | "identity"
  roles: Record<string, { targets: string[]; many?: boolean; required?: boolean; amount?: boolean }>
  nested?: Record<string, { item: JsonSchema; references?: Record<string, string> }>  // lines, stages, splits
  relationships?: string[]          // kinds from src/domain/relations.ts this type may report
  update: "in-place" | "re-propose" | "flag"
}
```

The store side, `src/store/sqlite/record-projectors.ts`, holds one projector per type, keyed by the same names; a
test asserts both key sets are equal and that `schemas/records-envelope.v1.schema.json` equals the schema generated
from the registry. The review kinds (`src/services/proposals/kinds/`), `decide()`, `keepDecision` and memo's review
list read `review` from it.

| Type | Review | Update after projection | Roles (`*` many) | Nested |
| --- | --- | --- | --- | --- |
| `person` | identity | in place (name; identities only on a person it created) | `member-of` (relationship, `as`) | — |
| `organization` | identity | in place (name only if nobody renamed it, as CRM does) | `customer-of`, `partner-of` (relationships) | — |
| `project` | identity | in place (name) | `organization` | — |
| `product` | direct | in place | `supplier` | — |
| `pipeline` | direct | in place | — | `stages` |
| `deal`, `lead` | direct | in place (same row CRM sync writes) | `organization`, `person*` (relationship, `as`), `project`; lead `deal` | — |
| `contract` | valued-proposal | re-propose while proposed, else flag | `project`, `deal`, `party*` (relationship, `as`), `document*` | — |
| `order` | proposal | re-propose, else flag | `customer`, `supplier`, `project`, `contract`, `deal`, `invoice`, `payment` | `lines` (→ `product`) |
| `invoice` | proposal | v1: flag | `issuer`, `counterparty`, `project`, `contract`, `subscription` | `lines` (→ `product`) |
| `payment` | proposal | v1: re-settle, else flag | `payer`, `payee`, `project`, `settles*` (amount), `refund_of`, `subscription` | — |
| `subscription` | proposal | re-propose, else flag | `supplier`, `customer`, `product`, `contract`, `project` | `prices` |
| `wallet` | direct | in place (not the opening balance) | `holder` | — |
| `transaction` | proposal | re-propose, else flag | `wallet` (required), `counterparty`, `payment`, `project` | `splits` |
| `custom:<name>` | direct, record only | — | any word | any JSON |

A role word the type does not list is kept in `record_relations` as the source's own, resolved record to record,
and neither projected nor refused, as v1 does (`relatedOf` skips it, `records.ts:203`). Roles new to a v1 type
(`contract`, `subscription`, `refund_of`) are read from relations only, never from `fields.<role>`, so a v1 file that
happens to carry such a field means what it meant.

`task` is not an envelope type: tasks have their own source columns, revision rule and duplicate chain (store v42);
an envelope `task` is refused with `record.type`, which says so.

"Re-propose" generalizes `resettle` (`records.ts:268`): when a record changes and its entity is still a proposal the
importer made, the projector updates the proposal in place and lists it in `proposed` again; once the owner decided,
the change is only flagged. Invoices keep v1's flag-only rule, so v1 files behave the same; that difference is
recorded in § Risks.

### Matching person, organization, project

Applied to every file (ruling 2). Records stored by an earlier version that still wait are matched or created on the
first import that touches them, or by `records match --account <a>` for the whole account at once.

| Type | Strong identifier | Lookup |
| --- | --- | --- |
| person | `fields.email` (one or a list), exact after trim and lower-case; `fields.phone` (one or a list), exact after normalizing to E.164 with the existing phone parser (`src/domain/phones.ts`) | `SELECT DISTINCT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id WHERE (i.provider = 'email' AND lower(i.external_id) = ?) OR lower(i.email) = ?` |
| organization | `fields.identifiers`: `{scheme, value}` with scheme `email`, `domain`, `tax-id:<cc>`, `registration:<cc>` | `organizations` live, joined through `organization_identities` to `identities` with `provider = scheme`, `external_id = value` |
| project | `fields.key` | `projects.key`, live |

Outcome per record, in this order:

1. The record is already mapped → nothing to match.
2. Exactly one entity matches every identifier the record gives → link (`entity_id` set, `created_entity` 0).
3. Two or more entities match, or the identifiers point at different entities → **ambiguous**: no entity, the record
   waits, the receipt lists it under `unmatched` with `candidates`.
4. Phone counts as a strong identifier, like e-mail (ruling 2). The Memory workstream treats a phone-only match as a
   proposal in its own linker; the two rules differ by the owner's choice, and the docs say so.
5. Nothing matches → **create** the entity, set `created_entity = 1`, and add the record's identifiers to it:
   - person: an identity `<account>/contact/<external_id>` under the source's provider (the shape `crmIdentityId`
     writes, so a deal from CRM sync and one from an envelope find the same person), and an `email` and `phone`
     identity per value, each linked with method `import`.
   - organization: an identity per identifier, joined through `organization_identities` with method `import`. A
     free-mail domain (the `FREE_MAIL` list) is refused as an organization's `domain` (`record.identifier`).
   - project: `key` taken when given and free; else the store's next key from the name.
6. A name alone never matches anything. Several e-mails where one matches person X and the rest match nobody: the
   record links to X. An import adds identifiers only to an entity it created, never to one it linked.

Organizations get no new columns: a tax id, a registration number and a domain are identities of the organization,
unique per scheme by `identities (provider, external_id)`. That is one rule for every strong identifier and no
second table. Readers of `identities` either filter by provider or join `identity_links`
(`src/store/sqlite/person-resolution.ts:12`, `crm.ts:256`), so these rows never show up as people. The mention linker
matches by `(provider, external_id)` and accepts an organization's identity (`mention-drain.ts:52`); a stored domain
mention would probably link to the organization, which is wanted, and is checked by a test.

An agent cannot map. Its route is the receipt's `candidates` and `records list unmatched:true`: it tells the owner,
who runs `records link`. A proper agent proposal is the memory workstream's `identity` kind, not built yet; this plan
adds no second one.

### Owner remapping

`records link <record> <ref>` (owner only, MCP-excluded, as today) may now remap a record whose entity the import
created (`created_entity = 1`). In one transaction it repoints the entity columns that this account's projected
records filled from this record (the registry's roles say which column), sets the record to the new entity, and
answers the old entity's ref as `unused` when nothing else points at it. The owner deletes or merges it; this plan
deletes nothing. A record mapped by the owner, or linked by identifier, still refuses a remap with `record.mapped`.

### Deletes

`operation: "delete"` and `records delete` are soft (`records.deleted_at`). The entity stays; a confirmed or
proposed entity is reported `flagged`, as v1 does. Relationships the record reported are withdrawn through
`syncReported` (#2628). A deleted product keeps its lines.

### Cross-account isolation

Records, relations and matching across records stay within one `account_id` (`records.ts:358`). A typed ref
(`organization:12`) and the strong-identifier lookup reach global entities, as entities are global today. A deal or
lead from an envelope upserts the row `(account_id, external_id)`: the same row CRM sync writes when provider and
account agree, and never another account's.

## Envelope changes (still `schema_version: 1`)

All additive; every v1 file stays valid and is processed as before.

| Change | Shape |
| --- | --- |
| New types | `deal`, `lead`, `pipeline`, `order`, `contract`, `subscription`, `product`, `wallet`, `transaction` |
| Per-type `fields` schema | generated from the registry; known keys typed, unknown keys kept in the record (`additionalProperties: true`) |
| Typed ref relation | `{ "role": "organization", "ref": "organization:12" }` in place of `type` + `external_id`; stored as `target_type = 'ref'` |
| Relationship role | `"as": "decision-maker"` on a relation whose role the registry marks as a relationship; stored in `record_relations.as_role`. One `as` per (role, target): the unique key `(record_id, role, target_type, target_external_id)` stays, so a party that is both customer and signatory is sent with one role |
| `refund_of` | a relation role on `payment` |
| Nested items | `fields.lines[]`, `fields.stages[]`, `fields.prices[]`, `fields.splits[]`; a line names its item by `product` (the product record's external id in this account) or `product_ref` (`product:4`) |
| Options | optional top-level `"options": { "lines": "text" \| "products" }`, default `text`. With `text`, an invoice line's `product` key is kept as data, as v1 does |
| Receipt | adds `unmatched[{key, pointer, reason, candidates}]` and `truncated` (§ Streaming); existing members unchanged |

Fingerprints: `recordFingerprint` adds `ref` and `as` to a relation only when present, so every stored v1
fingerprint stays the same and a v1 re-import is `unchanged`.

Validation order per record: envelope shape, then the type's field schema, then the roles the type lists (target type
allowed, `many`, `amount` only on `settles`, `as` only on relationships; other words are the source's own), then money (`money.amount`, `money.currency`), then the store. Every refusal keeps its
pointer and stable code. New codes: `record.identifier`, `record.ambiguous` (reported, not an error),
`finance.refund`, `finance.over-refund`, `finance.refunded`, `order.total`, `wallet.number`, `transaction.payment`.

A line whose product record has no entity yet makes its order or invoice **wait**, as a missing counterparty does.

### The example: one customer, end to end

Synthetic. A developer's ERP sends this JSONL (`example-erp`, account `demo`). Shown as one envelope for reading:

```json
{
  "schema_version": 1,
  "options": { "lines": "products" },
  "source": { "provider": "example-erp", "account": "demo", "batch_id": "2026-11-07" },
  "records": [
    { "key": "org", "type": "organization", "external_id": "C-1", "operation": "upsert", "revision": 1,
      "fields": { "name": "ООО Пример", "identifiers": [{ "scheme": "tax-id:ru", "value": "7700000000" }] } },
    { "key": "anna", "type": "person", "external_id": "P-1", "operation": "upsert",
      "fields": { "name": "Анна Образцова", "email": "anna@example.com" },
      "relations": [{ "role": "member-of", "type": "organization", "external_id": "C-1" }] },
    { "key": "pipe", "type": "pipeline", "external_id": "sales", "operation": "upsert",
      "fields": { "kind": "deal", "name": "Sales", "stages": [
        { "external_id": "new", "name": "New", "position": 1, "outcome": "open" },
        { "external_id": "won", "name": "Won", "position": 2, "outcome": "won" } ] } },
    { "key": "deal", "type": "deal", "external_id": "D-7", "operation": "upsert",
      "fields": { "title": "Rental fleet 2027", "pipeline": "sales", "stage": "new", "amount": "120000.00",
        "currency": "RUB" },
      "relations": [{ "role": "organization", "type": "organization", "external_id": "C-1" },
        { "role": "person", "type": "person", "external_id": "P-1", "as": "decision-maker" }] },
    { "key": "svc", "type": "product", "external_id": "SKU-RENT", "operation": "upsert",
      "fields": { "kind": "service", "name": "Bike rental, month", "unit": "month", "unit_price": "10000.00",
        "currency": "RUB" } },
    { "key": "contract", "type": "contract", "external_id": "K-2026-14", "operation": "upsert",
      "fields": { "name": "Rental agreement", "kind": "service", "status": "active",
        "effective_date": "2026-11-01", "expiration_date": "2027-10-31", "auto_renew": true,
        "notice_days": 30, "value": "120000.00", "currency": "RUB" },
      "relations": [{ "role": "party", "type": "organization", "external_id": "C-1", "as": "customer" },
        { "role": "deal", "type": "deal", "external_id": "D-7" }] },
    { "key": "order", "type": "order", "external_id": "O-55", "operation": "upsert",
      "fields": { "number": "O-55", "direction": "sale", "purpose": "business", "order_date": "2026-11-02",
        "currency": "RUB",
        "lines": [{ "product": "SKU-RENT", "quantity": "12", "unit_price": "10000.00" }] },
      "relations": [{ "role": "customer", "type": "organization", "external_id": "C-1" },
        { "role": "contract", "type": "contract", "external_id": "K-2026-14" }] },
    { "key": "inv", "type": "invoice", "external_id": "INV-901", "operation": "upsert",
      "fields": { "direction": "receivable", "number": "901", "currency": "RUB", "issue_date": "2026-11-03",
        "due_date": "2026-11-17",
        "lines": [{ "product": "SKU-RENT", "description": "Rental, November", "quantity": "1",
          "unit_price": "10000.00", "amount": "10000.00" }] },
      "relations": [{ "role": "counterparty", "type": "organization", "external_id": "C-1" },
        { "role": "contract", "type": "contract", "external_id": "K-2026-14" }] },
    { "key": "pay", "type": "payment", "external_id": "PAY-3", "operation": "upsert",
      "fields": { "direction": "in", "amount": "10000.00", "currency": "RUB", "date": "2026-11-05" },
      "relations": [{ "role": "payer", "type": "organization", "external_id": "C-1" },
        { "role": "settles", "type": "invoice", "external_id": "INV-901", "amount": "10000.00" }] },
    { "key": "quote", "type": "custom:quote", "external_id": "Q-7", "operation": "upsert",
      "fields": { "valid_until": "2026-11-30", "options": [{ "bikes": 12, "insurance": { "kind": "full" } }] },
      "relations": [{ "role": "quoted-for", "type": "deal", "external_id": "D-7" }] }
  ]
}
```

The order is a sale, so the owner is its supplier; its total is derived from its line. Until PR 5 (relationships
through `syncReported`) ships, `member-of` and the contract's `party` stay in `record_relations` only, and the deal's
person is written by `saveItem`'s existing `related-to` row. The memo acceptance test asserts the relationships
(`organizations context`, `contracts show` parties) only from the release that carries PR 5.

What the agent runs afterwards (released commands; § CLI and MCP):

```sh
memo records check erp.jsonl --account example-erp:demo --json
memo records import erp.jsonl --account example-erp:demo --json
memo review list kind:invoice,payment,order,contract --json
memo organizations context organization:1
memo deals show deal:1 --json
memo contracts show contract:1 --json
memo orders show order:1 --json
memo invoices show invoice:1 --json
memo records list type:custom:quote --account example-erp:demo --json
memo records show custom:quote:Q-7 --account example-erp:demo --json
memo search all "Rental fleet" --only business --json
```

Expected: one organization and one person created (`created_entity`), the deal written, the contract, order,
invoice and payment proposed, the payment allocated to the invoice, the quote a record whose `quoted-for` relation
resolves to the deal's record, and `deals show` listing it under source records. Run twice: every count `unchanged`.

This exact file runs in two places: memo's acceptance test (`src/records/business.test.ts`) and cli-docs'
`docs:report-fixture`, which runs the released memo against a synthetic store and renders `build-import-data`'s
outputs from that run.

## Streaming ingest

Core API, beside the unchanged `ingest(store, envelope, options)`:

```ts
ingestLines(store, lines: AsyncIterable<string>, options: IngestOptions & { onIssue?: (issue: IngestError) => void })
  : Promise<IngestReceipt>
linesOf(stream: NodeJS.ReadableStream): AsyncIterable<string>   // readline over a file or stdin
```

- The first non-empty line is the header (`schema_version`, `source`, optional `options`); the rest are records.
  Records are checked and buffered up to `chunk` (1000), written in one transaction, then dropped.
- Duplicate key and `(type, external_id)` checks use a `TEMP` table for the run, not in-memory sets.
- Waiting, unmatched and flagged are queried at the end from `records` by `(account_id, batch_id)`, not kept in an
  array. `completeDependents` runs per chunk, as now.
- Receipt counts are exact. Its lists (`errors`, `proposed`, `waiting`, `unmatched`, `flagged`) keep the first 1000
  entries each and set `truncated: true` beyond. `onIssue` gets every error as it happens; memo's `--jsonl` prints
  each as a line. Waiting and flagged stay readable later through `records list`.
- **Dry run** runs the whole stream in one transaction rolled back at the end: the only way the receipt is true for
  references between chunks. It holds the write lock for the run and grows the WAL file by the batch's size; the
  docs say so. A real run commits per chunk; a failure midway leaves earlier chunks written, and a re-run is
  idempotent.
- A JSON (not JSONL) envelope is still parsed whole. memo tells them apart by the first non-empty line: a JSON
  object without `records` is a JSONL header.
- MCP passes `input` as one JSON object, so a stream reaches MCP only as a JSON envelope.

Measured in cli-testing (§ Tests): peak RSS stays flat from 10k to 1M records.

## CLI and MCP (memo)

Every list filters with query words, never flags (cli-base `FLAG_ROLES`). Every command has `--json` and
`--compact`; writes go through `whoRuns` (owner confirmed, agent proposed) or `authorOf` (direct types).

| Group | Commands | Notes |
| --- | --- | --- |
| `products` | `list [kind:, supplier:, archived:]`, `show`, `add <name> [amount] [currency] --kind --unit --sku --organization`, `update <product> --amount --currency --title --unit --archived` | direct |
| `orders lines` | `add <order> <quantity> <amount> <description...> --product`, `remove <order> <position>` | on a proposed order (its author) or by the owner |
| `invoices lines` | same as orders | `invoices add` keeps its one-line form |
| `contracts` | `list [status:, kind:, project:, party:, review:, expires:]`, `show`, `add <name> --kind --organization* --person* --role --start-date --end-date --auto-renew --notice-days --amount --currency --project`, `update <contract> …` | `show` gives the notice deadline |
| `subscriptions` | `list [status:, direction:, supplier:, customer:, renews:]`, `show` (price history), `add <name> <amount> <currency> --kind --supplier --customer --product --contract --interval --start-date --trial-end`, `update <subscription> --status …`, `cancel <subscription> --occurred-time` | |
| `subscriptions prices` | `add <subscription> <amount> <currency> --start-date` | a row, never an edit |
| `wallets` | `list [kind:, currency:]`, `show <wallet> [--until-time]` (balance, pending), `add <name> <currency> --kind --institution`, `update <wallet> --opening-balance --opening-date --title` | opening balance owner-only |
| `transactions` | `list [wallet:, direction:, status:, category:, project:, review:, uncategorized:]`, `show`, `add <wallet> <amount> --kind in\|out --occurred-time --description`, `update <transaction> --payment --status` | |
| `transactions splits` | `add <transaction> <amount> <category...> --project`, `remove <transaction> <position>` | |
| `payments` | `add … --refund-of <payment>` | refund |
| `records` | adds `show <record>`, `delete <record> --account`; `list` gains `entity:`, `unmatched:`, `batch:`, `deleted:` | `records show` lists relations both ways and the entity |

Also:

- `memo show <ref>` opens every new ref (`LOCAL_OPENS`, `src/show/command.ts:17`): `product`, `contract`,
  `subscription`, `wallet`, `transaction`, plus the existing `invoice`, `payment`, `order`, `deal`, `lead`,
  `pipeline`, which it lacks today. Each entity's `show` lists its source records (`records` rows mapped to it, and
  records whose relation resolves to them).
- `records link` and `records show` parse `custom:<name>:<id>`: today's `recordOf` splits at the first colon
  (`cli-memo src/records/mapping.ts:33`), so `custom:quote:Q-7` reads as type `custom`. Fixed in the memo PR.
- `review` gains kinds `contract`, `subscription`, `subscription_price`, `transaction` (`src/review/kinds.ts:9`). The
  receipt text names the kinds from the registry instead of `kind:invoice,payment` (`src/records/import.ts:40`).
- **Search.** One new lane `business` in core's `RESOURCES_SEARCHED` (`src/services/search-all.ts:24`): ref titles of
  invoices, payments, orders, contracts, subscriptions, products and wallets, folded in memory like `deals.find`, no
  index and no migration. Transactions are left out: a bank statement gives tens of thousands a year, too many to fold
  per query; `transactions list` filters them. `custom:` records are not in it; they are reached from the entity they
  relate to and by `records list`. The lane is in `RESOURCES_SEARCHED`, which memo's `search all` reads, and the test
  at `src/services/search-all-meetings.test.ts:97` changes with it. tg and max are to get the lane too, **deferred
  until permission keys for these types exist** (see PR 6): their `search all` reads `SOURCE_SEARCHED`, which has no
  `crm` either, and no key there could leave business data out of an agent's search. Each hit carries the source record's provider and
  account when the entity came from one.
- **MCP** stays the three-tool bridge. No new stdin command: `records import` and `records check` are already in
  `src/mcp/catalogue.ts:35`. `records delete` is a write at `ask`. `records link` stays excluded.
- **Permission keys** (dotted paths, parent covers children): `products`, `contracts`, `subscriptions`, `wallets`,
  `transactions`, `orders.lines`, `invoices.lines`, `records.delete`. Defaults: reads allow, writes ask. Added to
  `OWNER_PERMISSIONS` deny: `wallets.update` (it carries the opening balance; core refuses an agent anyway).

### cli-base must add (one PR, released before memo uses them)

| Kind | Words |
| --- | --- |
| nouns, collection | `contracts`, `subscriptions`, `prices`, `wallets`, `transactions`, `splits`, `lines` |
| noun meaning change | `products`: "goods and services the owner sells or buys, with their prices" |
| verbs | none new. `cancel` meaning widens to "stop a job, a pending thing or a subscription". `pause`/`resume` are process words, so a subscription pauses by `update --status paused` |
| flags, value | `--refund-of <payment>`, `--payment <payment>`, `--product <product>`, `--contract <contract>`, `--supplier <party>`, `--customer <party>`, `--wallet <wallet>`, `--status <status>`, `--interval <count-unit>` (`1-month`), `--trial-end <date>`, `--notice-days <n>`, `--auto-renew <on\|off>`, `--opening-balance <decimal>`, `--opening-date <date>`, `--institution <text>`, `--unit <text>`, `--sku <code>`, `--archived <on\|off>` |
| flag meaning change | `--start-date`, `--end-date`: "the first (last) day of something that lasts whole days, such as an all-day event or a contract" |

## Docs to update

| Repo | Page | Change |
| --- | --- | --- |
| cli-core | `docs/dev/ARCHITECTURE.md` § Entities and source records | the type registry, projectors, streaming ingest |
| cli-core | `docs/dev/KNOWLEDGE.md` § Money, § Source records and imports | new tables, refunds, bank model, matching rules, review policy |
| cli-core | `docs/storage/schema.md` | regenerated (`pnpm schema:render`); spec modules `scripts/schema/finance.mjs`, `crm.mjs`, `records.mjs`, new `business.mjs` |
| cli-core | `schemas/records-envelope.v1.schema.json`, `docs/storage/records-envelope.md` (new) | generated schema; prose, every type, the example, error codes |
| cli-core | `docs/storage/relationships.md` (new, or a section of KNOWLEDGE) | the § Relationship rules table |
| cli-core | `docs/dev/COORDINATION.md` | version 57; next free 58 |
| cli-core | `CHANGELOG.md` | Added: tables, types, `ingestLines`; Changed — may break callers: net paid, search lane `business` |
| cli-core | `docs/dev/BACKLOG.md` | delete CORE-45 (stale: shipped as deals); fix `finance.ts:355` "opportunities" |
| cli-memo | `docs/usage.md` "Keep track of money", "Track deals and leads"; new `docs/business.md` (products, contracts, subscriptions, wallets, transactions, imports); `docs/meta.json`, `docs/index.md` row | user guides |
| cli-memo | `skills/cli-memo/topics/money.md`, `search.md`, `proposals.md`; `SKILL.md` topic list (< 4000 chars) | agent topics |
| cli-memo | `docs/commands.md` (`pnpm generate`), `src/examples.ts` (1–3 per new leaf), `contracts/help.snap`, `docs/dev/test-matrix.md`, `contracts/upgrade.json` (store 57) | generated |
| cli-docs | `content/docs/data-model.mdx` (+ `.ru`, `.es`), `content/data/data-model/{en,ru,es}.json` | regenerated from core's schema.md; pin moves to the release |
| cli-docs | `content/docs/build-concepts.md:78-80` (+ twins) | the "Add a source" step only: an existing canonical entity first, then `custom:<name>` for a source object with no canonical meaning, then a new core entity only when a question needs its rules |
| cli-docs | `content/docs/how-things-are-linked.md` (+ twins) | business entities and their relations |
| cli-docs | `content/docs/build-import-data.md` (+ `.ru.md`, `.es.md`, new) | the example envelope, `ingest`/`ingestLines` from a CLI, the agent's commands, rendered by `docs:report-fixture` |
| cli-template | `README` and an example `src/import.ts` | calling `ingestLines(openStore(), linesOf(stdin), { account })` |
| cli-testing | `performance/records/jsonl-streaming/README.md` + script | why, setup, results, what was not measured |

## Tests

Synthetic data only. "core" = `src/store/*.test.ts` unless named; "memo" = cli-memo.

| Requirement | Test | Repo |
| --- | --- | --- |
| every canonical type imports and projects | `records-types.test.ts`: one record of each type → entity or proposal per registry | core |
| registry, schema file and projectors agree | `record-types.test.ts` | core |
| nested custom object kept as sent | `records-custom.test.ts`: deep JSON round-trips, fingerprint stable | core |
| custom ↔ deal | `records-custom.test.ts`: `quoted-for` resolves; `deals show` lists it | core + memo |
| deal ↔ org, contract ↔ order, invoice ↔ contract, line → product | `business.test.ts` | memo |
| allocations, refunds, net paid, status after full refund, void after refund | `finance-refunds.test.ts`, plus trigger tests writing raw SQL | core |
| invalid allocations, over-refund, refund before original confirmed | same | core |
| multi-currency totals, JPY and BHD scales on new tables | `business-money.test.ts` | core |
| bank: balance with opening, pending excluded, payment link rule, splits ≤ amount | `money-transactions.test.ts` | core |
| subscription prices never overwritten, current price | `subscriptions.test.ts` | core |
| repeat import unchanged; revision rules; re-propose while proposed; flag after confirm | `records-revisions.test.ts` | core |
| invalid and stale records refused with pointer and code | extend `records.test.ts` new cases only | core |
| source deletion: entity kept, flagged, relationships withdrawn | `records-delete.test.ts` (withdrawal part after #2628) | core |
| unresolved refs wait across batches, then project | `records-waiting.test.ts` | core |
| cross-account isolation | two accounts, same external ids, nothing crosses | core |
| identifier auto-link (one email, one phone), ambiguous (two), create, a waiting v1 record matched on re-import | `records-matching.test.ts` | core |
| owner remap of an import-made entity; agent refused; agent sees `candidates` | `records-link.test.ts` | memo |
| deal from envelope = CRM sync row | sync then import same account → one row | core |
| CLI retrieval of each type | one `command.test.ts` per new group | memo |
| MCP retrieval and write availability | `src/mcp/business.test.ts` | memo |
| search lane and source refs | `search-all-business.test.ts`; memo `search all --only business` | core + memo |
| v1 compatibility | every existing case in `src/store/records.test.ts` and memo `src/records/import.test.ts` unchanged and green; a fixture of v1 files checked against the new schema | core + memo |
| streaming: stdin and file, dry run receipt, truncation | `ingest-lines.test.ts` | core |
| streaming memory | 10k / 100k / 1M lines, peak RSS | cli-testing |
| migration 57 on a v56 file | `version-57.test.ts` | core |

## Pull requests, in order

| # | Repo | Size | Contents | Needs | Release |
| --- | --- | --- | --- | --- | --- |
| 1 | cli-core | XS | COORDINATION.md: version 57 for business entities; announce in issue #849 | #2628 merged | — |
| 2 | cli-core | M | Type registry and projector registry for today's five types; generated envelope schema equals the shipped file; no behavior change, existing tests unchanged | — | — |
| 3 | cli-core | L | Migration 57 (tables, columns, triggers, `--custom` rules; manifest rows, `pnpm db:bundle`, `scripts/schema/*.mjs`, `wirecat.store.speaks` → 57, `version-57.test.ts`), stores (`store.products`, `store.contracts`, `store.subscriptions`, `store.wallets`, `store.transactions`), refs and titles, `ENTITY_TABLES`, `REFERABLE`, ref summaries, refunds and net paid, proposal kinds, `decide` generalized | 1, #2628's v56 migration | — |
| 4 | cli-core | L | Envelope: new types, field schemas, typed ref relations, nested items, matching (`records match`), re-propose; `ingestLines` and streaming | 2, 3 | — |
| 5 | cli-core | S | Relationships through `syncReported`; contract roles in `relations.ts` | 4, #2628 follow-up | — |
| 6 | cli-core | S | Search lane `business`; docs, schema.md, CHANGELOG | 4 | **core release** (5 may follow in a later release) |
| 7 | cli-base | S | Nouns, meaning changes, flags | owner approves wording | **cli-base release** |
| 8 | cli-memo | M | Bump core and cli-base; `products`, `orders lines`, `invoices lines`, `contracts`, `subscriptions`, `wallets`, `transactions`, `payments --refund-of`, `records show/delete`, record key fix | 6, 7 | — |
| 9 | cli-memo | M | `memo show` opens, search `--only business`, MCP test, permissions, review kinds, skills, docs, examples, generated files, acceptance test with the example | 8 | **memo release** |
| 10 | cli-template | S | `ingestLines` example | 6 | template release |
| 11 | cli-docs | M | data-model regenerate, build-concepts step, how-things-are-linked, `build-import-data` (+ twins), report fixture | 9 | site deploy |
| 12 | cli-testing | S | JSONL streaming memory measurement | 6 | — |

## Tradeoffs considered and rejected

- `schema_version: 2` for the new behavior — the owner asked for v1 extended; an `options` member keeps one schema.
- One `parties` table for contracts — relationships with roles already model it and get reported standing from #2628.
- Contract ↔ order/invoice as links — #2628's split: structural relations are FKs.
- Subscription parties as relationships — exactly one of each, read by money rules; columns, as invoices.
- A stored running balance — drifts from its transactions; the sum is cheap per wallet.
- A category table for splits — no question needs category rules yet; folded free text groups them.
- Multi-currency wallets — a balance per currency inside one row means a second money table; one row per currency.
- Negative payment amounts for refunds — breaks the v45 `amount > 0` rule and every sum; direction plus `refund_of`.
- Credit notes — not asked for; a refund covers the money; an invoice correction is void plus a new invoice.
- `account_id`/`external_id` on new tables — the records layer already maps; two routes would disagree.
- Tax id and domain columns on organizations — one more place for identifiers; identities already are unique per scheme.
- E-mail-suffix domain matching on import — a heuristic; wrong links are worse than a waiting record.
- An FTS index for the business lane — titles are short and few; the deals lane shows folding is enough.
- Persisting receipts — `batch_id` on every record already says what a batch wrote.
- `task` as an envelope type — tasks have their own source and duplicate rules.

## Risks

- **Mixed builds.** An older memo (core ≤ 0.602) computes paid gross and its `settle()` can rewrite a refunded
  invoice's status. Only memo writes money and it pins an exact core; tg and max do not. The CHANGELOG says to
  update memo first.
- **Invoices keep v1's flag-only update rule** while new proposal types re-propose. Debt until a later envelope
  version unifies them.
- **Any provider/account pair is accepted** (`accountPk` upserts, `src/store/sqlite/accounts.ts:36`). An envelope that
  names a CRM's provider and account updates the CRM's deals; the next sync writes them back. Documented, not refused.
- **Streamed dry run holds the write lock** for its whole run.
- **Re-importing an old v1 file creates entities** for records that waited for `records link` (ruling 2). A dry run
  lists them under `created` first; the owner's real payment sheet should be dry-run before its next import.
- **Phone links differ from the Memory linker**, which proposes on a phone-only match. Owner's choice; documented.
- **#2628's shape may still change**; PR 5 waits for it, PRs 2–4 do not touch `links`.

## Owner answers (2026-11-07)

1. Phone-only exact match: **links, as e-mail does.**
2. Financial accounts: **`memo wallets`, `wallet:<id>`.**
3. Matching and creation: **always**, every file; no `options.match`. The two existing tests that expect a waiting
   person or organization change with PR 4.
