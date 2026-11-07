# Cross-source knowledge metadata

The `./store` export provides `MessageStore.knowledge`, over the same SQLite connection as messages,
people and tasks. Every operation takes an explicit `AccountKey`; it never connects to a messenger.
Its rows are the store's tables ([`schema.md`](../storage/schema.md)): an annotation is a `notes` row
about its target, a label a `taggings` row, a relationship a `links` row, a reminder a `reminders` row.

## Annotations and labels

`addAnnotation`, `annotation`, `annotations`, `editAnnotation` and `removeAnnotation` support message
locators, chats, contact identities, persons, tasks, organizations, projects, notes, documents and meetings.
A meeting is named by its store id and, like a chat, belongs to the account the call names. The target is the note's subject (`notable_type`/`notable_id`); a contact note is a note about an `identity`. An
annotation has
a stable ID, owner authorship, creation/update times and a revision. Edits require the current revision.
Listing accepts an optional target, literal text, limit (1–500) and offset (0–100000).

Source annotations survive source edits and deletion. Reads report `available`, `deleted` or
`unavailable`, resolving the source now; no source excerpt is copied into the annotation record.
Explicit account purge removes that account's metadata. Existing private contact note IDs remain
readable/editable through both interfaces. Legacy contact notes retain their existing identity-purge
policy; general source annotations retain their target reference when an identity disappears.

Labels on messages/chats/identities reuse the messenger tags. Labels on a person, task, organization,
project, note, document, meeting or notes folder are taggings on that row; a subfolder's label is a `labelled` link
from the folder, anchored at the path. A tag of kind `topic` is made by the owner only (`createTag` refuses
an agent's: it goes to `proposedActions`), its name is never also a tag's, and `setMainTopic` marks one
topic per thing as its main one. A reference from the old `messages.db` (a ULID, `entity:`) resolves as not found. A
message or chat reference of an `email` account names the email or the email thread in the mail tables,
and falls back to a message or chat saved before mail had tables of its own. They are explicit metadata and do not
automatically relabel every linked identity or its messages. `labelled` returns references, labels,
current target state and truthful pagination. Identity link/unlink does not silently transfer or
duplicate owner annotations, labels or relationships attached to a different person UID.

## Relationships

`addOrganization` creates a company, team, family or community; `addProject` a project with its task key
(made from the name when none is given) and type. `relate` records a relationship between explicit references, with
optional role/evidence. Its kinds, their ends and their roles are one registry, `RELATIONS` in
`src/domain/relations.ts`; `pair()` refuses ends a kind does not join and a role off the list those ends name, and
says which roles it takes:

| Kind | From → to | Roles |
|---|---|---|
| `member-of` | person, chat, mail thread, organization, project → organization, project | a person's: `employee`, `contractor`, `founder`, `owner`, `manager`, `adviser`, `contact` on an organization; `owner`, `manager`, `contributor`, `client-contact`, `approver` on a project; others free text |
| `reports-to` | person → person (read backwards: `manages`) | none |
| `customer-of` | person, organization → organization (read backwards: `supplier of`) | none |
| `partner-of` | organization ↔ organization, stored once with the lower id as `from` | none |
| `related-to` | person, organization, project, task, deal, lead → person, organization, project, task | a deal's or lead's: `owner`, `contact`, `decision-maker`, `influencer`; others free text |

A job title is never a role. Inverses are never stored. Every relationship read carries a derived `standing`:
`confirmed` (the owner's), `reported` (a source account's that nobody confirmed), `proposed` (a suggestion waiting
for review) or `ended` (`ends_at` passed, or the source stopped reporting it: `deleted_at`). Store version 56 gives a
relationship link the account that reported it (`account_id`), when it held (`starts_at`, `ends_at`) and a history,
`link_revisions`, written by triggers. One pair may hold several roles: the key is kind, ends, anchor, role and account, so a
CRM's claim never replaces the owner's, and `relate` without a role answers the pair's link that is there. Readers that count relationships (`personPreparation`, `projectStatus`, the stored project
gathering) take the usable ones, confirmed or reported, through `usableLink`. Who works on a task is
`store.tasks.assign` (`task_assignments`: assignee, reviewer or watcher), not a link; store version 2 copied
the old `assigned-to` links there. A relationship is a confirmed owner statement or an explicitly
unconfirmed weak suggestion with provenance. An agent's or a rule's relationship is a `relationship`
proposal (`proposeRelation`), not a link. `confirmRelation` records the decision; weak
suggestions are excluded from confirmed person/task context. Removing a link to a project, or a suggestion,
leaves a rejected `relationship` proposal, so a scan never proposes the pair again. Domain matching never links identities.
Listing/removal are account-scoped. Repeating the same relation preserves
its ID; remove and add again to correct its role/evidence. References stay on their original UID
through identity linking and splitting, so correction is explicit rather than guessed.

## Local reminders

Reminders point only at tasks (`tasks.id`; callers name a task by the task package's id or its key) and store an absolute ISO instant plus an IANA display timezone.
`schedule` requires an open task; the same active task/time returns the existing reminder.
`claimReminders` leases due work, bounded at 500 deliveries, with compare-and-set updates so competing
workers cannot claim the same live lease. Expired leases can be retried with a new receipt.
The host deduplicates by reminder ID and revision. `acknowledgeReminder` accepts only the current
receipt before lease expiry; repeating an already completed acknowledgement is idempotent.

Snooze requires the current revision and creates a new delivery identity. Cancellation invalidates
receipts. Closing a task cancels pending/leased reminders through a trigger. State survives restart.
Delivery is a host decision: this store makes no outbound messenger/email call and sets no system timer.
An import timer does not authorize outbound reminder delivery.

A task's `next_check_at` is not a reminder: it is when an agent should look at the task again, and
`tasks agenda` lists the task from then. Nothing delivers it and nothing reaches the owner; a reminder
is for the owner, a next check for the agent.

## Facts, memories and what agents do

A memory is what was derived; a fact is what happened. `facts` holds a `fact`, `statement`, `question`,
`decision` or `promise` with its evidence (`links` of kind `evidence`), author and an optional subject,
project and scope: an agent's waits as proposed, the owner's is accepted at once. Only a decision is
superseded (accepting one that replaces another ends the older) or reversed; a question's answer is a
`links` row of kind `answered-by`. `fact:<id>` names one. `memories`
holds what agents concluded — summary, digest, preference — with author bot and model, confidence,
status and a scope that has no default: a memory without scope or evidence is refused. A memory that `supersedes`
another retires it when it is confirmed, not when it is proposed, and a memory is superseded once only. Memories have
their own words index. `proposedActions` keeps what an agent wants done outside the store until the owner
approves or rejects it; `list` filters by status. `approveAsTask` (`./services`) approves one as a `request`
task in the account that would act, with source `proposed-action:<id>`, and records `{ task }` as its result;
a retry finds the same task. A messenger adapter could instead execute an approved one and report `executed`
or `failed`. The payload may hold a reply's text, shown to the approver and never logged. `agentActions` is
the audit trail: the MCP server writes one row per tool call (tool, tier, outcome code, times), never its
arguments; `list` filters by tool and by the agent's name, such as `tg-mcp`.

## Who decides a proposal

Every decide method takes a `Decider`: `"owner"`, or `{ bot, model?, reason }` for an agent the host lets
decide for the owner. Each runs `mayDecide` before it changes anything: an agent needs a reason, never
decides its own bot's proposal (every Claude Code session is the bot `claude-code`), never a rule scorer's or
one that names no author, and nothing unless the host's `agent_decisions` is on: `openStore` keeps it off unless
the host passes `decisions: { agentDecisions: true }` from the owner's explicit `agent_decisions: true`. Mail and
meeting findings, task close suggestions, and any row marked `ownerOnly` (a registry row takes it from its kind), are the owner's alone even
then: `mayDecide` reads the row's stored `kind`, so a path that sees the batch as a generic action refuses too. `proposalRegistry`
(`./services`) is the one inbox over every kind (`relationship`, `key_document`, `fact`, `invoice`, `payment`,
`order`, `memory`, `findings`, `mail_findings`, `meeting_findings`, `task_close`, `action`); a new kind is a `ProposalKind` that registers its id `prefix` or the stored proposal kinds it owns.
Ids are bare numbers for stored proposals and `fact:`, `invoice:`, `payment:`, `order:`, `memory:`, `link:`, `key:` for the rest;
a task close is `close:<task key>` (`close:Q-15`). `parseProposalIds` reads ranges and lists of them (never a range of
task keys); only a findings batch takes part ids (`17080/f2`). A link
keeps no actor, only provenance text, so an unconfirmed link is the owner's alone to decide, and only the owner
removes a link or writes a confirmed link of any kind (`notes.addLink`, `relate` with `by: "owner"`); an agent's
link is written unconfirmed. Only the owner removes, reverses or revokes an accepted fact; an agent withdraws only
its own proposed fact or memory. Only the owner confirms a correction that retires a confirmed memory. `facts.revoke` returns an agent's accepted fact to proposed and keeps the step,
with the decision it took back, in `metadata.history`; it refuses the owner's own fact and an accepted correction,
whose superseded fact's earlier status is not kept. The policy is set once at `openStore({ decisions })` and read by every check. An agent's
`relate` returns a `relationship` proposal.

A relationship's `role` says who the other side is ("client"); its `purpose` says what a chat is for in the project.
The store keeps no list of purposes: memo's config holds them and checks one before it is written, and `null` means
`work`. `knowledge.updateRelation` sets either or both (`null` clears one): the owner's change applies, an agent's is a
`relationship_update` proposal the owner decides like any other. Store version 44 moved the unconfirmed agent and
rule links into `relationship` and `key_document` proposals on the first writable open after it, with their bot,
reason and time. The bot comes from the link's provenance text, which anyone could write, so the moved row keeps that
text under `suggestedLink` and only the owner decides it. Drive's editor links stay links. A suggestion an older build
writes after that stays a link and is still listed as `link:<id>` or `key:<id>`.

## Money

`store.finance` keeps invoices, their lines, payments and allocations as typed tables (store version 45), not facts.
An amount is an integer in the currency's minor units (`CURRENCY_SCALES`, ISO 4217: RUB 2, JPY 0); callers pass and
read decimal strings ("50000.00"), and a currency outside the table is refused. Nothing is converted: totals are per
currency. An invoice's total is the sum of its lines, a line's amount is quantity × unit price, a payment's
allocations never exceed it nor an invoice's total, and both sides share one currency; the code refuses each with a
reason and triggers refuse a write that slips past. The status (`draft`, `issued`, `partly_paid`, `paid`, `void`)
follows the allocations of confirmed payments; only the owner issues a draft or voids an invoice nothing is
allocated to. The owner's entry is confirmed at once; an agent's or an import's is `review: proposed`, an `invoice`
or `payment` proposal named by its own ref, which only the owner decides. A bot allocates only from a payment it
proposed that is still proposed. An invoice's limit counts confirmed payments only, so a pending proposal never blocks
the owner; confirming a payment checks the limit again and is refused, the payment staying proposed, when other
confirmed payments already cover the invoice. A rejected payment's allocations go, and so do pending ones to an
invoice the owner voids. `openTotals` sums what confirmed open invoices
still owe, per direction and currency.

A payment is never a fact (store version 46): `facts.add` refuses type `payment` (`fact.payment-retired`) and a
trigger refuses one from an older build. An agent's evidence finding of kind `payment` writes money when the owner
accepts it: a paid one is a `payment:` row, paid on `paid_at`, else the due date, else the day it is accepted; an
expected one is an `invoice:` of one line, which needs a `person:` or `organization:` counterparty; a paid one that
`supersedes` an invoice is allocated to it as far as it is open, and a cancelled one voids it. The agent proposes the
row and the owner's acceptance confirms it in the same write. The first writable open after version 46 moved the
payment facts the same way; a fact that could not be a row stays a `statement` with its fields under
`metadata.retired_payment`. `projects status` lists payments and open invoices from `store.finance`, and its open
total counts confirmed invoices only.

`store.orders` keeps orders (store version 50): whom an order is for (`customer`, a `person:` or `organization:`, the
owner's own person when left out), why (`purpose`: `personal`, `business`, `client` or `other`), the shop as its mail
names it (`supplierName`) with an optional `supplier` reference, the shop's number, an optional amount with its
currency, a status (`placed`, `shipped`, `delivered`, `cancelled`, `returned`), the order and delivery days, and
optional `invoice:` and `payment:` links. Like an invoice, the owner's entry is confirmed at once and an agent's is an
`order` proposal only the owner decides. One shop's number is stored once (`order.duplicate`, the name compared in any
letter case); `orderOfShop` finds it again, and only the owner moves its status on (`setStatus`). Since store
version 51 an order also keeps `sourceUrl`, its http or https page at the shop.

A task keeps, since store version 51, the id of what it is about in an outside service (`externalId`, given and shown
as `<service>:<id>` such as `avito:4512345678`, stored as `tasks.provider` and `tasks.external_id` so two services'
ids never collide) and the http or https page it is about (`sourceUrl`). Several tasks may share one id: a buyer who
writes every day gets a task a day. A mail `task` finding carries both as `external_id` and `source_url`.

`store.deals` keeps sales pipelines and the deals and leads in them (store version 52). A pipeline (`pipeline:<id>`)
holds deals or leads (`kind`), is the owner's own or a CRM account's (`account_id`, `external_id`), and is named by its
reference or by a name only one pipeline has (`pipeline.ambiguous` lists the candidates). Its stages are in order and
have an `outcome` (`open`, `won`, `lost`). Deals (`deals`, `deal:<id>`) and leads (`leads`, `lead:<id>`, with the
`deal_id` it became) have a title, an optional organization and project, a stage, a status kept apart from the stage,
an optional expected amount with its currency, the expected close day and the day it closed. Moving to a stage whose
outcome ends it closes it, and `close` moves it to the stage of that outcome when the pipeline has one. The people on
it are `links` of kind `related-to` with a `role` (`owner`, `contact`, `decision-maker`, `influencer`). The owner and his agents
write alike, with no review; only the author is kept. Triggers write each stage a row enters to
`pipeline_stage_changes`, and `pipeline(ref)` counts from it how many rows reached each stage and the conversion to
the next. The migration seeds the lead pipeline `Leads` (`new`, `contacted`, `qualified`, `won`, `lost`).

### Relationships a source reports

`store.relations.syncReported(account, relationships, scope)` writes what a source account says as a diff keyed by the
relationship's unique key: one it newly reports is a `reported` link with the account (`confirmed = 0`,
`account_id`), or a `relationship` proposal when the account's setting `crm.<provider>:<account>.links` is `review`
(that setting governs new relationships only; links already stored stay usable); one it still reports is kept (no
history row); one inside `scope` it no longer reports is withdrawn (`deleted_at`), never deleted. A link the owner
confirmed is never withdrawn and stays `confirmed`, and once confirmed the sync takes it as present. Another role on
a pair is another relationship, never a conflict. The only case where the owner's word stops the source: the owner
removed or rejected that very relationship, role included (every removal leaves a rejected `relationship`
proposal); the answer counts those in `skippedOwnerRejected`. A ref the store does not hold is an issue in the
answer, not an error.

The CRM sync uses it for every relationship a CRM reports: a contact `member-of` its companies with role `contact`
(the job title in `metadata.position`), a deal's or lead's contacts with their deal role, the deal's `assignee` as
`owner`, each active user `member-of` the account's own companies (`organizations.metadata.own` with
`own_by`: the CRM sets and clears only its own mark, `knowledge.setOwnOrganization` sets the owner's, which no sync
changes) as `employee` (an inactive user's withdrawn), and, when the CRM
lists departments, `reports-to` the head of the user's department, a head the head of the parent one
(`metadata.derived = "department-head"`; no head, no link). A CRM user is an identity `<account>/user/<id>`, joined
to a person by exact email as a contact is. With `crm.<provider>:<account>.company-types` mapping a company type to
`customer-of`, `supplier` or `partner-of`, a company of that type becomes a customer of, a supplier to or a partner
of the own company; every stored company is checked once the run read the companies, so a new setting applies on the
next sync. A field the CRM left out (`organizations`, `people`, `assignee`, `type`, `users()`,
`departments()`, a user's `departments`) withdraws nothing. A relationship whose other end is not stored yet waits in
the account's sync state (`crm:pending-relations`, read and written once per page) and is written at the end of a
later sync; it is dropped when its row is deleted, after 30 days or past 5000, with one issue. A deal owner is not
waited for when the CRM lists no users. Each sync replaces `crm:gaps`, what it could not read (a kind the CRM has
not, users or departments not listed or refused with their code), which `crmGapsOf` reads. A contact whose email
belongs to two people is named in the sync's issues until the owner separates it.

A mail findings batch (`store.mailFindings`) also takes `invoice`, `payment`, `order` and `order_update` findings.
Staging runs what accepting would write through `store.finance` or `store.orders` and rolls it back, so a batch the
owner could not accept is refused with the same reason; an `order_update` needs the stored order of its
`supplier_name` and `number` (`order.not-found`). Accepting writes the owner's confirmed row with the cited mail as its
evidence; an `order_update` sets the status, the delivery day of a delivered one, and adds its mail to the order's
evidence. Certificate numbers, account ids and expiry dates are `fact` findings: the statement carries them.

A party the store may not hold yet is given by name: an invoice's `counterparty_name`, a payment's `payer_name` or
`payee_name`, an order's `customer_name`, each in place of the reference and with an optional `<party>_email` that
must have sent or received a cited email. Accepting finds the organization that address belongs to, else one with
an address at its company domain (never a free mail domain), else one of exactly that name (case and accents
ignored), else makes a `company`, and joins the address to it; more than one match is refused (`finance.party`). An
`order` whose shop and number already wait in a proposed batch is refused (`order.proposed`), as a stored one is
(`order.duplicate`).

`mailFindings.check` makes every check `stage` makes, the trial writes included, and rolls back, listing each
finding's problem rather than stopping at the first; `memo mail findings add --dry-run` is built on it. An unknown
field is refused with its name, its finding's id and kind, and the fields that kind takes (`finding.unknown-field`);
a missing one, such as `reason`, which every kind needs, with what that kind needs (`finding.missing-field`). Both
read `MAIL_FINDING_FIELDS`, which `mailFindingFieldsHelp()` prints for a host's `--help`.

## Source records and imports

`ingest(store, envelope, { account, dryRun })` (`./services`) takes what a source sends: the v1 envelope
(`RECORDS_ENVELOPE_SCHEMA`, written out as `schemas/records-envelope.v1.schema.json`, JSON Schema 2020-12), or a JSONL
file through `envelopeOfJsonl` (a header line with `schema_version` and `source`, then one record per line). Each
record lands in `records` (store version 47), unique per account, type and external id, with its fields as untrusted
JSON and a fingerprint of fields and relations: the same import twice writes nothing. A revision below the stored one,
or the same revision with other content, is refused (`record.stale-revision`); a delete is soft. A field named like a
secret or holding a known credential shape is refused (`record.secret-field`). Every refusal carries a JSON pointer
and a stable code; the receipt counts created, updated, unchanged, deleted and refused records. A dry run writes in a
transaction it rolls back.

An `invoice` or `payment` record becomes an `invoice:` or `payment:` proposal by the bot `import`, never a confirmed
row. Its `counterparty`, `issuer`, `payer`, `payee` and `project` come from a store ref in its fields or from a
relation to another record of the account; a payment's `settles` relations allocate it to those invoices: by the
relation's `amount` when it has one (amounts past the payment are `record.over-payment`), else as far as the payment
and what other payments, confirmed or proposed, leave open on the invoice allow. A changed record of a payment the
import proposed and the owner has not decided takes its allocations again (`store.finance.unallocate`, then the
relations) and is flagged only when more than its `settles` relations changed. A relation whose target is not imported, or has no entity, keeps the record waiting (`waiting` in the
receipt); it gets its entity when the target does. A `person`, `organization` or `project` record gets its entity
only from the owner (`store.records.map`), never by name. A record changed or deleted at the source after its entity
was made leaves the entity alone and is `flagged`.

## Link proposals from scorers

`scanProjectLinks(store, { project, sources, since, write })` (`./services`) proposes a project's likely chats, mail
threads and people from what the store holds. Each `LinkScorer` is one file in `src/services/link-scorers/` and one
line in `SCORERS`: `chat-title`, `alias-hits`, `member-chats`, `member-dialog`, `chat-senders`, `mail-thread`. A
scorer only reads the sources it is given (there is no default account) and returns candidates with a weight, a
reason of ids and counts, never message text, and evidence references. The scan combines each pair's strongest
signal per scorer as 1 − Π(1 − w), keeps those at `threshold` (0.5) or more, highest first, and writes at most
`limit` (20) new ones through `proposeRelation` as the rule bot `memo-scan`, which only the owner decides. A pair a
link joins, or any rejected `relationship` proposal for it, is never proposed again, whatever the scorer or its
version; a pending one is updated in place under the same id, and an agent's keeps its author. People are found
only by an identity (a sender or a member): a person candidate without one, or with someone else's, is refused and
counted under `skipped.nameOnly`, and the owner is never one. A candidate may carry a `purpose` from the host's
configured list (`chat-title` reads one the title names). With `write: false` nothing is written. `project: null`
runs `PERSON_SCORERS`, today `email-domain`, the shared-domain rule `relationships scan` used, at 0.3.

## Document extraction

`./documents` exposes `extractText`, `importEngine`, limits and extraction types. Markdown/TXT/CSV/TSV
use UTF-8 text; HTML and RTF are read to their visible text. PDF, DOCX and DOC use `unpdf`, `mammoth` and `word-extractor`,
dependencies of this package; XLSX, PPTX, ODT, ODS, ODP and EPUB use the bounded built-in readers. Spreadsheets (XLSX, ODS, CSV, TSV) read row by row under their header (`sheetText`). PDF results expose page spans. Missing engines,
unreadable files, scans requiring an agent, unsupported formats and oversized inputs are distinct.
Legacy XLS/PPT and automatic OCR are not supported.
