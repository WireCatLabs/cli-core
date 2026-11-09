# The records envelope

How a source (an ERP, a CRM export, a bank statement, a sheet) sends its records to the store. The envelope is JSON
Schema 2020-12, published as [`schemas/records-envelope.v1.schema.json`](../../schemas/records-envelope.v1.schema.json)
and generated from the type registry `RECORD_TYPES` (`src/domain/record-types.ts`) by `pnpm schema:envelope`; a
test holds the file to the registry, and another holds the store's field check to a standard validator's verdicts.
`schema_version` stays `1`: every
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
  `delete`), `fields` (an upsert needs them, at most 64 KiB), `revision`, `relations` (at most 100). A key a type
  types may also be `null`, as v1 read a missing value, unless the type requires it.
- `options.lines`: `text` (the default) keeps an invoice line's `product` as data, as v1 did; `products` reads it as the
  product record's external id. Order lines always read it. `product_ref` (`product:4`) names a store product on any
  line.
- `options.phone_region`: the country (`es`, `RU`) a person's phone written without `+` is read in (§ Matching);
  without it such a number is never an identifier. A vCard import passes its region here too.
- A byte-order mark before the first line is skipped. `envelopeOfText(text)` reads a file's text as JSON or JSONL.
- **JSONL** is the same model: the first non-empty line holds `schema_version`, `source` and `options`, each further
  non-empty line one record. A line that is not JSON is refused at its index. A JSON object with `records` is a whole
  envelope, not a header.

## Types

Every type below is an entity type and a ref prefix, except that a message's ref is its locator (`msg:`). Anything else a source has is `custom:<name>`: kept as a record
with its fields and relations, never projected. `task` is refused (`record.type`): tasks have their own source rules.

| Type | Becomes | A changed record | Roles (`*` several, `as` a relationship) | Nested in `fields` |
| --- | --- | --- | --- | --- |
| `person` | matched or made | name and identifiers, on one the import made; else flagged | `member-of` (as) | — |
| `organization` | matched or made | the same; the name only if nobody renamed it | `customer-of`, `partner-of` (as) | — |
| `project` | matched by key or made | the same | `organization` | — |
| `product` | written | in place | `supplier` | — |
| `pipeline` | written | in place | — | `stages` |
| `deal`, `lead` | written, on CRM sync's row | in place | `organization`, `person`* (as), `project`; a lead `deal` | — |
| `contract` | proposed with a value, else written | re-proposed while the import's untouched proposal, else flagged | `project`, `deal`, `party`* (as), `document`* | — |
| `order` | proposed | re-proposed, else flagged | `customer`, `supplier`, `project`, `contract`, `deal`, `invoice`, `payment` | `lines` |
| `invoice` | proposed | flagged (v1's rule) | `issuer`, `counterparty`, `project`, `contract`, `subscription` | `lines` |
| `payment` | proposed | its settles taken again while proposed and only the import allocated it, else flagged | `payer`, `payee`, `project`, `settles`* (amount), `refund_of`, `subscription` | — |
| `subscription` | proposed | re-proposed (a new price is added), else flagged | `supplier`, `customer`, `product`, `contract`, `project` | `prices` |
| `wallet` | written; the opening balance stays in the record | in place | `holder` | — |
| `transaction` | proposed | re-proposed (splits replaced), else flagged | `wallet` (required), `counterparty`, `payment`, `project` | `splits` |
| `message` (kind `sms`) | written, an SMS of the account | in place, as an edit | `counterpart` | — |
| `event` (kind `call`) | written, a call of the account | in place | `counterpart` | — |

Each type's known `fields` keys are typed in the schema (`$defs/fields-<type>`); any other key is kept as sent. An
import never writes confirmed money: what feeds a total is a proposal of the bot `import` that only the owner decides.
A contract without a value, a product, a pipeline, a deal, a lead and a wallet feed no total and are written directly.

**Re-proposing never overwrites the owner.** The import keeps a digest of what it last wrote of a proposal it may
re-propose (its row and its lines, prices or splits). The owner may edit a proposal without deciding it; once the
digest no longer matches, a change from the source is only `flagged`. That holds for any other writer too, such as
another CLI's process: the safe side, at the cost of flagging an edit nobody meant to keep. A payment takes its
settles again only while every allocation on it is the import's own.

## Relations

- `{ "role": "counterparty", "type": "organization", "external_id": "C-1" }` names another record of the same
  account; `{ "role": "counterparty", "ref": "organization:12" }` names a store entity. Records never resolve across
  accounts; refs and identifiers reach the store's entities, which are global.
- A role the type lists is held to its targets (`record.invalid`), and one it takes once is refused twice
  (`record.relation-ambiguous`). v1's roles (`issuer`, `counterparty`, `project`, `payer`, `payee`, `settles`) keep v1's
  rules: their target type is not checked, and `fields.<role>` may hold a store ref instead.
- `as` is the part a relationship target plays (`decision-maker`, `customer`), kept in `record_relations.as_role`. One
  `as` per role and target. A deal's or lead's `person`, a person's `member-of`, an organization's `customer-of` and
  `partner-of` and a contract's `party` are relationships the import reports (§ Relationships); a contract's
  `document` is kept in the record only.
- A role word the type does not list is the source's own: kept, resolved record to record, never projected.
- `amount` only on `settles`: the payment's share of that invoice.
- A relation, a line's `product` or a deal's `pipeline` whose target has no entity yet keeps the record **waiting**; it
  is projected when the target gets one, in this run or a later one. The receipt names the missing roles, a field's as
  `fields.pipeline` or `fields.lines.product`, and points at the field when only fields are missing. A deal stands in a
  pipeline CRM sync wrote without waiting.

## Relationships

Each chunk reports the relationships of the entities its records stand for through `store.relations.syncReported`,
under the envelope's account (`links.account_id`, `links.source = 'import:<provider>'`, proposals by the bot `import`), one call per
entity type: the entities are the call's `scope.from` and the type's relationship kinds its `scope.kinds`. A call
carries every relationship of the entities it lists, gathered from every live record of the account mapped to the
entity, so a second record of the same person never withdraws what the first reports.

| Role | Link | Its role list |
| --- | --- | --- |
| deal's or lead's `person` | `related-to` deal → person | the deal roles |
| contract's `party` | `related-to` contract → person or organization | `customer`, `supplier`, `signatory`, `guarantor` (`contract`) |
| person's `member-of` | `member-of` person → organization | the organization roles |
| organization's `customer-of`, `partner-of` | organization → organization | none |

- `as` is the link's role only when its list holds it, the owner's own roles of that list included. Any other word is
  kept on a link without a role, in `metadata.source_role`, a list of every word the account's records used for
  that pair (both sides of a partnership too); `record_relations.as_role` keeps each record's word. A word a list
  does not hold is also a `notices` entry (`relationship.role-unlisted`), never an error, and once the owner adds it
  to the list the next import writes the link with that role and withdraws the one without. On a relationship with
  no list, `as` is always only `source_role`.
- A person's `fields.position` (text, up to 200 characters) is the job title on each of its `member-of` links,
  `metadata.position`; a title never becomes a role, and `employee` is never inferred from one. Known limit: one
  position per person, written to every one of their `member-of` links; when two records of the account stand for
  the same person, the most recently changed one's position is the one written.
- A relationship whose target has no entity yet is left out until it gets one, in this run or a later one, or by
  `records match` or `records map`; the records that point at it are reported again then. A partnership one side
  reports is kept when the other side is imported again.
- A record that changes reports its new set: a new role on a pair is a new link, the one no longer sent is withdrawn
  (`deleted_at`). A deleted record's entity is reported with what its account's other live records still say, often
  nothing, and a record whose target was deleted no longer reports the link to it.
- The owner's word wins: a link he confirmed is never withdrawn, and one he removed or
  rejected, role included, is never written again (`skippedOwnerRejected`). An entity he rejected, such as a proposed
  contract, or one that is deleted reports nothing: rejecting a contract withdraws its parties at once, and a
  re-import does not bring them back. With `crm.<provider>:<account>.links` set to `review` a new link is a
  `relationship` proposal.
- Each writer withdraws only its own links: a call withdraws the account's links whose `source` is its own, so a
  CRM's links (`crm`) are never withdrawn by an import, even one sent under the CRM's own provider and account, and
  the CRM's sync never withdraws the import's (`import:<provider>`). When both report the exact same relationship on one account they
  share one link: only the writer that made it withdraws it, and the other's next report restores it.
- `relationships` in the receipt counts each link once per run, however many chunks report it, and each issue or
  notice is listed once. An issue about a record of an earlier batch, reported again because what it points at
  changed, has the pointer `""` and names the record (`record: {type, externalId}`).
- A dry run reports the same counts and writes none.

## Matching person, organization, project

Every file, v1 files included. A name alone never matches.

| Type | Strong identifiers |
| --- | --- |
| person | `fields.email` (one or a list), trimmed and lower-cased as every writer of an e-mail identity keeps them; `fields.phone` (one or a list), read to E.164 (below) and compared with `phone` identities and with the number a contact keeps (`identities.phone`, with or without `+`; a number kept in another spelling does not match); and the source's own contact identity `<account>/contact/<external id>` under its provider, the one CRM sync writes, a `/` or `%` in the account or id escaped |
| organization | `fields.identifiers`: a list of `{scheme, value}` with scheme `email`, `domain`, `tax-id:<cc>` or `registration:<cc>`, stored as identities of the organization under the scheme, an e-mail under `org-email`, so a company's address is never a person's identity. An e-mail also matches the `email` identity mail findings or mentions gave a company. Any other item is kept as data |
| project | `fields.key` |

- The identifiers point at no entity: the import **makes** one, marked `createdEntity`, and gives it the record's
  identifiers. A value that does not read as an e-mail or a phone is no identifier and stays in the fields, as v1
  kept it. A free-mail domain is refused as an organization's domain (`record.identifier`).
- They point at exactly one: the record **links** to it, and nothing is added to that entity.
- They point at two or more: the record **waits**, listed under `unmatched` with the `candidates`. The owner says
  which one it is with `store.records.map`; an agent only reports it. Its `reason` is `record.ambiguous`.
- **A phone** written with `+` or `00` is international. Without them it is an identifier only when the envelope names
  `options.phone_region` and the number is valid there. The store's `phone_countries` setting
  ([Numbers from other countries](../mentions.md#numbers-from-other-countries)) never decides it: with `ru`, the US
  number `4155550100` reads as a Russian one. Otherwise the number stays in the fields, never matches, and the
  receipt lists it under `ignored` (`record.phone-region`).
- A person record changed later that names another person's e-mail or phone gives its entity nothing and is
  `flagged`, with `reason: "record.ambiguous"` and that person among the `candidates`.
- `record.separated` instead of `record.ambiguous`: the one person the identifiers match is one the owner separated
  from an identity the record brings, so linking would join two people he told apart.
- Phone counts as e-mail does, by the owner's choice; the Memory workstream's own linker treats a phone-only match as a
  proposal.
- A record an earlier version left waiting is matched or made on the next import that sends it, unchanged or not, or
  for a whole account by `store.records.match({ provider, account })`.

**Owner remapping.** `store.records.map(key, ref, "owner")` on a record whose entity the import made moves it, and
every record of the account linked to that entity, to `ref`; repoints what their records filled from them (the columns
their roles name), the identities the import gave it and the relationships the account reported from it, and of the
records that point at it; and answers the old entity as `unused` when
nothing points at it any more. Its `proposed` and `errors` are those of the records that waited on it. The owner deletes or merges it; the
store deletes nothing. A record linked by an identifier or mapped before refuses a remap (`record.mapped`), and only
the owner maps (`record.map-owner-only`).

**Reading records back.** `store.records.list({ provider, account, … })` narrows one account's records by `type`,
`entity` (a ref: the records mapped to it), `batch` (the `batch_id` that last wrote it), `deleted` (`true` only deleted,
`false` only live, left out both), and `waiting`, `unmatched` or `flagged`. `store.records.incoming(target)` lists the
relations of live records pointing at a record (a key) or at an entity (`{ entity: ref }`): those naming it by `ref`,
from any account, and those resolved to a record mapped to it. Relations a record's fields make are left out of both.

## Deletes and revisions

`operation: "delete"` is soft: the record is marked, its entity stays, and a proposed or confirmed entity is reported
`flagged`. Once a revision is stored every later version sends one; a lower one, or the same one with other content,
is `record.stale-revision`. The same fields and relations in any order give the same fingerprint, and a relation
without `ref`, `as` or `amount` keeps the fingerprint v1 stored, so an old file re-imports as `unchanged`.

## Streaming

```ts
import { ingest, ingestLines, jsonlLines } from "@wirecat/cli-core/services"

const receipt = await ingestLines(store, jsonlLines(process.stdin), { account: "demo", onIssue: (e) => log(e) })
```

- `ingest(store, envelope, options)` takes a parsed JSON envelope; `ingestLines` reads JSONL line by line, writes
  every 1000 records (`chunk`) in one transaction, holding only the chunk being written (peak memory over large
  files is not measured yet). Duplicate keys and
  `(type, external_id)` are checked in a `TEMP` table, and the receipt's lists are read from the store at the end.
- The receipt's counts are exact; each list keeps its first 1000 entries and sets `truncated`. `onIssue` (on `ingest`
  too) gets every refusal as it happens. It must not use the store: it runs inside the run's transaction, and during a
  dry run its statements are refused (`store.dry-run`) rather than rolled back unseen.
- A real run commits per chunk: a failure midway leaves earlier chunks written, and running it again is idempotent.
- **A dry run is one transaction, rolled back at the end**, so its receipt is true for references between chunks. It
  holds the store's write lock for the whole run, so tg, max and memo wait meanwhile, and the WAL file grows by the
  batch's size until the next checkpoint. Any other read or write through the same store handle while it runs is
  refused (`store.dry-run`, code `conflict`), through the hand-written SQL and Drizzle alike; a store method throws the
  refusal itself, not Drizzle's query error around it. It would otherwise land inside the dry run and be rolled back.

## Receipt

`{ dryRun, source, created, updated, unchanged, deleted, refused, proposed, waiting, flagged, unmatched, ignored,
errors, truncated }`. `proposed` lists the proposals made or changed; `waiting[{key, pointer, missing}]`,
`flagged[{key, pointer, entity, reason?, candidates?}]`, `unmatched[{key, pointer, reason, candidates}]`,
`ignored[{key, pointer, reason}]`; `relationships{added, kept, restored, withdrawn, proposed, skippedOwnerRejected}`,
the links of § Relationships; `notices[{pointer, code, message, key}]`, taken but not as sent; `errors[{pointer, code,
message, key, record?}]`, the pointer an RFC 6901 JSON pointer into the envelope.

## Error codes

| Code | When |
| --- | --- |
| `envelope.invalid`, `envelope.schema-version`, `envelope.account-mismatch` | the envelope itself; no record is taken |
| `record.invalid` | the record's shape, a field against its type's schema, a role's target, `as` on a role that is no relationship |
| `record.type` | a type that is none of the above and not `custom:<name>` |
| `record.duplicate-key`, `record.duplicate` | a key or a `(type, external_id)` seen earlier in the run |
| `record.too-large`, `record.secret-field` | fields over 64 KiB; a secret-named key or a credential-shaped value |
| `record.relation-ambiguous` | two targets for a role that takes one |
| `record.identifier` | a free-mail domain given as an organization's `domain` |
| `record.ambiguous`, `record.separated` | reported in `unmatched` (and `flagged`), not refusals: § Matching |
| `record.phone-region` | reported in `ignored`, not a refusal: a phone without `+` and no `options.phone_region` |
| `record.entity` | the store refused the entity or proposal the record stands for, with no code of its own |
| `store.dry-run` | another read or write of the store handle while a dry run holds it |
| `record.stale-revision`, `record.not-found` | revisions; a delete of a record never imported |
| `record.over-payment` | settles amounts past the payment |
| `record.reference-not-found` | a `ref` the store lacks; a deal's stage its pipeline lacks |
| `record.map-owner-only`, `record.map-type`, `record.mapped` | `store.records.map` |
| `relationship.invalid`, `relationship.reference-unknown` | in `errors`, not refusals: ends the registry does not join, or a `ref` the store lacks; the pointer is the record's `relations`, or `""` with `record` named when it was not in this envelope |
| `relationship.role-unlisted` | in `notices`: an `as` its role list does not hold, kept as `metadata.source_role` |
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

## Spreadsheets

A sheet holds one type. `recordColumns(type)` lists its columns and `recordTemplate(type, "csv")` writes the header
row to fill; `envelopeOfCsv(text, { type, source })` reads the filled sheet as an envelope, and `placeOf(pointer)`
turns a receipt's pointer into the sheet's line and column.

- **Columns.** `external_id`, then the type's fields that hold one value, then one per role, then one per key of each
  list of items (`lines.description`, `lines.amount`). A column the type lacks is refused, naming it.
- **Roles.** A role with one target type takes the target's external id (`wallet` = `W-1`); a role with several takes
  `<type>:<external id>` (`counterparty` = `organization:C-1`). A role that takes many splits on `|`.
- **Lists.** A row that repeats an earlier row's `external_id` adds one item to the record's list, as an invoice
  exported a line a row does; its other cells may stay empty.
- **What Excel writes.** The separator is read from the header (`;`, `,` or a tab); a byte-order mark is skipped;
  `10 000,50` is read as `10000.50` and `09.11.2026` as `2026-11-09`; a currency is upper-cased. Anything else is left
  for the envelope's own checks.
- SMS and calls have no table: they come from a phone's own export.

## Phone data: SMS, calls, contacts

A phone export is one envelope (JSON or JSONL) of one source account: `message` records of kind `sms`, `event`
records of kind `call`, and `person` records from the address book or from the numbers the export saw.
`envelopeOfVcard` turns a `.vcf` file into such an envelope. Both types are written directly (`review: direct`):
they carry no money.

**One account per phone.** The records, the SMS and the calls of an import all stay in the account it names
(`--account phone:pixel`), so an account group (WC-ACCT-13) lists the phone once and reaches all of it. A search lane
reads the accounts whose provider **holds** its kind, and a provider may hold several (`kinds`): the seeded `phone`
holds `messages` and `events`. A call's calendar entry has `event_type: call`, so `events list event_type:call` lists
calls among the calendars' events. No column is added.

**Only an import-only provider takes them.** A messenger's or a calendar's account belongs to its sync, so a
`message` or `event` record under any provider whose entry is not marked `imported` is refused
(`record.provider-not-imported`) before anything is written: the seeded `phone` is marked, `telegram`, a calendar
provider or an unregistered `sheet` are not. A built-in's flag is its own; another provider takes it only from the
first entry of its name, and a later entry can neither strip nor add it. An SMS is never written into a chat of the account whose membership is not `imported` (`record.chat`),
and its counterpart's identity is under the import's own provider.

```json
{ "key": "sms-1", "type": "message", "external_id": "sms-1",
  "fields": { "kind": "sms", "direction": "in", "phone": "+447700900111", "name": "Иван Петров",
              "body": "Буду в 10", "sent_at": "2026-11-01T09:12:00+01:00", "read": true },
  "relations": [{ "role": "counterpart", "type": "person", "external_id": "+447700900111" }] }
{ "key": "call-1", "type": "event", "external_id": "call-1",
  "fields": { "kind": "call", "direction": "missed", "phone": "+447700900111", "started_at": "2026-11-01T10:00:00Z",
              "duration": 0 },
  "relations": [{ "role": "counterpart", "type": "person", "external_id": "+447700900111" }] }
```

**SMS → chats and messages.**

- One chat per thread in the account: `fields.thread` (the phone's thread id) when sent, else the counterpart's
  number read to E.164 as a person record's phone is (with `+`, or in `options.phone_region`; as written otherwise:
  a short code, a sender name such as `ExampleBank`). Kind `dialog`, membership `imported`, the title `fields.name` or the number.
- `direction`: `in` is the counterpart's message, `out` the owner's (`outgoing`, no sender). The counterpart is an
  identity of the account's provider whose id is the number, kept as the identity's `phone` too, a member of the chat and
  seen by the account, so the person's context and `search messages` read it as a messenger contact.
- `body` is the text, `sent_at` (ISO 8601 with an offset) the time. `read` (an incoming message the owner opened) is
  kept in the message's metadata: the store has no per-message read state for incoming messages.
- The message is written through the messenger path (`upsertMessage`), so its words and meaning are indexed as a
  messenger's; `messages.source` is `import:<provider>`. A changed record edits the text, as an edit does. A change
  that moves it to another thread (a new `thread` or number) is refused (`record.moved`): delete the record and send
  it again under a new `external_id`.
- A deleted record's SMS is a tombstone, as a messenger's deleted message is; a deleted call's entry is cancelled and
  its event marked deleted, so neither is found any more. A deleted record sent again is live again: its SMS and its
  call come back.
- An import-only account says nothing of a search's coverage: no fetch could add to what its import wrote.
- MMS attachments are out of scope: a record's other fields are kept in the record only.

**Calls → events.** One calendar `calls` in the account, made on the first call. No sync reads it, and
`events list` does not report an import-only account as incomplete. Each call is a calendar
entry (`event_type: call`, `transparency: transparent`, so it never counts as busy or overlapping) and the event it
makes: start `started_at`, end start plus `duration` seconds, title `fields.name` or the number, description
`incoming call`, `outgoing call` or `missed call`. Direction, duration and number are in the entry's metadata.

**The counterpart.** `counterpart` names the person record of the number (one, optional). That record is matched
or made as § Matching says: one exact phone links, none makes a person, two or more leave the person `unmatched`
with its candidates, and the SMS or call **waits** until the owner maps it. Never by name. Once the person is known,
the SMS identity is linked to that person (`method: import`, so an owner's remap moves it), and a call gets a link
`related-to` (role `counterpart`) from the event to the person, read by `events list person:` and by the person's
context. A record without `counterpart` keeps only the number. A source sends one person record per number, keyed
by the number or its contact id; a vCard contact with the same number links to the same person.

**vCard → envelope.** `envelopeOfVcard(text, { provider, account, batchId, region })` in `src/domain/vcard.ts`,
exported from the package, gives `{ envelope, issues }`. `isVcard(text)` tells a `.vcf` from a JSON or JSONL file,
and `ingestVcard(store, text, { account, provider, batchId, region })` (`@wirecat/cli-core/services`) converts and
imports it in one call, its receipt with the converter's `vcard` issues beside the import's.

- vCard 2.1, 3.0 and 4.0: folded lines, quoted-printable (with 2.1's soft breaks) decoded in its `CHARSET`
  (UTF-8, windows-1251, KOI8-R), `\,` `\;` `\n` escapes, `item1.` groups. The converter takes text: a file whose
  plain values are in another charset than UTF-8 is decoded by the caller first.
- One `person` record per card: `FN`, else `N` as given then family name; `TEL` read to E.164, `EMAIL`.
- A number with `+` or `00` is read as is. A national number is read only with `region` (a country of
  `phone_countries`), which the envelope also carries as `options.phone_region`; without it, it stays in
  `fields.phone_unread`, is no identifier, and is reported in `issues`.
- `ORG` is one `organization` record per name in the file (`external_id` `org:<folded name>`), and the person is
  `member-of` it; `TITLE` is kept in `fields.title`, and is the relation's `as` when it reads as a word (`cto`).
  Each account gets its own organization for an `ORG` name: a name never matches across accounts or entities.
- `external_id` is the card's `UID` (hashed when it is longer than 512 characters), else a hash of its name, numbers
  and addresses: a card without UID whose numbers change is a new record. `REV` is not a `revision`: a source that never sends one could not change it later.
- `PHOTO`, `LOGO`, `SOUND`, `KEY` are skipped.
- Nothing is dropped quietly: a card cut by another `BEGIN:VCARD` or by the end of the file, an unknown `CHARSET`
  (read as UTF-8), a card with no name, number or address (left out) and a repeated `UID` are each in `issues`. A
  quoted-printable soft break never joins a card's `BEGIN` or `END`.
