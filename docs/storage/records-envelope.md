# The records envelope

How a source (an ERP, a CRM export, a bank statement, a sheet) sends its records to the store. The envelope is JSON
Schema 2020-12, published as [`schemas/records-envelope.v1.schema.json`](../../schemas/records-envelope.v1.schema.json)
and generated from the type registry `RECORD_TYPES` (`src/domain/record-types.ts`). `schema_version` stays `1`: every
v1 file is still valid, and behaves as before except that a person, organization or project record is now matched or
made (§ Matching).

## Shape

```json
{
  "schema_version": 1,
  "source": { "provider": "example-erp", "account": "demo", "batch_id": "2026-11-07" },
  "options": { "lines": "products" },
  "records": [
    { "key": "org", "type": "organization", "external_id": "C-1", "operation": "upsert", "revision": 1,
      "fields": { "name": "ООО Пример" }, "relations": [] }
  ]
}
```

- `source.account` must be the account the caller names (`envelope.account-mismatch`). A provider and account pair is
  created on first use; an envelope that names a CRM's own provider and account writes that CRM's deals.
- A record is `key` (unique in the envelope; the receipt cites it), `type`, `external_id`, `operation` (`upsert` or
  `delete`), `fields` (an upsert needs them, at most 64 KiB), `revision`, `relations` (at most 100).
- `options.lines`: `text` (the default) keeps an invoice line's `product` as data, as v1 did; `products` reads it as the
  product record's external id. Order lines always read it. `product_ref` (`product:4`) names a store product on any
  line.
- **JSONL** is the same model: the first non-empty line holds `schema_version`, `source` and `options`, each further
  non-empty line one record. A line that is not JSON is refused at its index. A JSON object with `records` is a whole
  envelope, not a header.

## Types

Every type below is an entity type and a ref prefix. Anything else a source has is `custom:<name>`: kept as a record
with its fields and relations, never projected. `task` is refused (`record.type`): tasks have their own source rules.

| Type | Becomes | A changed record | Roles (`*` several, `as` a relationship) | Nested in `fields` |
| --- | --- | --- | --- | --- |
| `person` | matched or made | name and identifiers, on one the import made; else flagged | `member-of` (as) | — |
| `organization` | matched or made | the same; the name only if nobody renamed it | `customer-of`, `partner-of` (as) | — |
| `project` | matched by key or made | the same | `organization` | — |
| `product` | written | in place | `supplier` | — |
| `pipeline` | written | in place | — | `stages` |
| `deal`, `lead` | written, on CRM sync's row | in place | `organization`, `person`* (as), `project`; a lead `deal` | — |
| `contract` | proposed with a value, else written | re-proposed while the import's proposal, else flagged | `project`, `deal`, `party`* (as), `document`* | — |
| `order` | proposed | re-proposed, else flagged | `customer`, `supplier`, `project`, `contract`, `deal`, `invoice`, `payment` | `lines` |
| `invoice` | proposed | flagged (v1's rule) | `issuer`, `counterparty`, `project`, `contract`, `subscription` | `lines` |
| `payment` | proposed | its settles taken again while proposed, else flagged | `payer`, `payee`, `project`, `settles`* (amount), `refund_of`, `subscription` | — |
| `subscription` | proposed | re-proposed (a new price is added), else flagged | `supplier`, `customer`, `product`, `contract`, `project` | `prices` |
| `wallet` | written; the opening balance stays in the record | in place | `holder` | — |
| `transaction` | proposed | re-proposed (splits replaced), else flagged | `wallet` (required), `counterparty`, `payment`, `project` | `splits` |

Each type's known `fields` keys are typed in the schema (`$defs/fields-<type>`); any other key is kept as sent. An
import never writes confirmed money: what feeds a total is a proposal of the bot `import` that only the owner decides.
A contract without a value, a product, a pipeline, a deal, a lead and a wallet feed no total and are written directly.

## Relations

- `{ "role": "counterparty", "type": "organization", "external_id": "C-1" }` names another record of the same
  account; `{ "role": "counterparty", "ref": "organization:12" }` names a store entity. Records never resolve across
  accounts; refs and identifiers reach the store's entities, which are global.
- A role the type lists is held to its targets (`record.invalid`), and one it takes once is refused twice
  (`record.relation-ambiguous`). v1's roles (`issuer`, `counterparty`, `project`, `payer`, `payee`, `settles`) keep v1's
  rules: their target type is not checked, and `fields.<role>` may hold a store ref instead.
- `as` is the part a relationship target plays (`decision-maker`, `customer`), kept in `record_relations.as_role`. One
  `as` per role and target. A deal's `person` becomes the deal's person link, `as` its part (`contact` when left
  out); `member-of`, `customer-of`, `partner-of` and a contract's `party` and `document` are kept in the record only
  until relationships reach `links`.
- A role word the type does not list is the source's own: kept, resolved record to record, never projected.
- `amount` only on `settles`: the payment's share of that invoice.
- A relation, a line's `product` or a deal's `pipeline` whose target has no entity yet keeps the record **waiting**; it
  is projected when the target gets one, in this run or a later one. The receipt names the missing roles, a field's as
  `fields.pipeline` or `fields.lines.product`. A deal stands in a pipeline CRM sync wrote without waiting.

## Matching person, organization, project

Every file, v1 files included. A name alone never matches.

| Type | Strong identifiers |
| --- | --- |
| person | `fields.email` (one or a list), trimmed and lower-cased; `fields.phone` (one or a list), read to E.164 with the store's `phone_countries` setting; and the source's own contact identity `<account>/contact/<external id>` under its provider, the one CRM sync writes |
| organization | `fields.identifiers`: `{scheme, value}` with scheme `email`, `domain`, `tax-id:<cc>` or `registration:<cc>`, stored as identities of the organization |
| project | `fields.key` |

- The identifiers point at no entity: the import **makes** one, marked `createdEntity`, and gives it the record's
  identifiers. A free-mail domain is no organization's domain (`record.identifier`), nor is a malformed e-mail or phone.
- They point at exactly one: the record **links** to it, and nothing is added to that entity.
- They point at two or more: the record **waits**, listed under `unmatched` with the `candidates`. The owner says
  which one it is with `store.records.map`; an agent only reports it.
- Phone counts as e-mail does, by the owner's choice; the Memory workstream's own linker treats a phone-only match as a
  proposal.
- A record an earlier version left waiting is matched or made on the next import that sends it, unchanged or not, or
  for a whole account by `store.records.match({ provider, account })`.

**Owner remapping.** `store.records.map(key, ref, "owner")` on a record whose entity the import made repoints what this
account's records filled from it (the columns their roles name, a deal's people) and the identities the import gave
it, and answers the old entity as `unused` when nothing points at it any more. The owner deletes or merges it; the
store deletes nothing. A record linked by an identifier or mapped before refuses a remap (`record.mapped`), and only
the owner maps (`record.map-owner-only`).

## Deletes and revisions

`operation: "delete"` is soft: the record is marked, its entity stays, and a proposed or confirmed entity is reported
`flagged`. Once a revision is stored every later version sends one; a lower one, or the same one with other content,
is `record.stale-revision`. The same fields and relations in any order give the same fingerprint, and a relation
without `ref`, `as` or `amount` keeps the fingerprint v1 stored, so an old file re-imports as `unchanged`.

## Streaming

```ts
import { ingest, ingestLines, linesOf } from "@wirecat/cli-core/services"

const receipt = await ingestLines(store, linesOf(process.stdin), { account: "demo", onIssue: (error) => log(error) })
```

- `ingest(store, envelope, options)` takes a parsed JSON envelope; `ingestLines` reads JSONL line by line, writes
  every 1000 records (`chunk`) in one transaction, and keeps one chunk in memory. Duplicate keys and
  `(type, external_id)` are checked in a `TEMP` table, and the receipt's lists are read from the store at the end.
- The receipt's counts are exact; each list keeps its first 1000 entries and sets `truncated`. `onIssue` gets every
  refusal as it happens.
- A real run commits per chunk: a failure midway leaves earlier chunks written, and running it again is idempotent.
- **A dry run is one transaction, rolled back at the end**, so its receipt is true for references between chunks. It
  holds the store's write lock for the whole run, so tg, max and memo wait meanwhile, and the WAL file grows by the
  batch's size until the next checkpoint.

## Receipt

`{ dryRun, source, created, updated, unchanged, deleted, refused, proposed, waiting, flagged, unmatched, errors,
truncated }`. `proposed` lists the proposals made or changed; `waiting[{key, pointer, missing}]`,
`flagged[{key, pointer, entity}]`, `unmatched[{key, pointer, reason, candidates}]`; `errors[{pointer, code, message,
key}]`, the pointer an RFC 6901 JSON pointer into the envelope.

## Error codes

| Code | When |
| --- | --- |
| `envelope.invalid`, `envelope.schema-version`, `envelope.account-mismatch` | the envelope itself; no record is taken |
| `record.invalid` | the record's shape, a field against its type's schema, a role's target, `as` on a role that is no relationship |
| `record.type` | a type that is none of the above and not `custom:<name>` |
| `record.duplicate-key`, `record.duplicate` | a key or a `(type, external_id)` seen earlier in the run |
| `record.too-large`, `record.secret-field` | fields over 64 KiB; a secret-named key or a credential-shaped value |
| `record.relation-ambiguous` | two targets for a role that takes one |
| `record.identifier` | a malformed e-mail or phone, or a free-mail domain |
| `record.stale-revision`, `record.not-found` | revisions; a delete of a record never imported |
| `record.over-payment` | settles amounts past the payment |
| `record.reference-not-found` | a `ref` the store lacks; a deal's stage its pipeline lacks |
| `record.map-owner-only`, `record.map-type`, `record.mapped` | `store.records.map` |
| the store's own codes | `finance.*`, `order.*`, `contract.*`, `subscription.*`, `wallet.*`, `transaction.*`, `product.*`, `money.*` when an entity is refused |

## The example

[`schemas/examples/records-business.jsonl`](../../schemas/examples/records-business.jsonl) (exported as
`@wirecat/cli-core/schemas/examples/records-business.jsonl`) is one synthetic customer end to end: an organization
by tax id, a person by e-mail and member of it, a pipeline, a deal with the person as decision-maker, a service, a
contract with a value, a sale order with one line of that service, an invoice and the payment that settles it, and a
`custom:quote` about the deal. Imported, it makes the organization and the person, writes the pipeline, deal and
product, proposes the contract, order, invoice and payment, allocates the payment, and keeps the quote as a record
whose `quoted-for` resolves to the deal's record. Run twice, every record is `unchanged`
(`src/store/records-example.test.ts`).
