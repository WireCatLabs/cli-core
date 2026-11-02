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
(made from the name when none is given) and type. `relate` records manual `member-of`
or `related-to` links between explicit references, with optional role/evidence. Who works on a task is
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
status and a scope that has no default: a memory without scope or evidence is refused. Memories have their
own words index. `proposedActions` keeps what an agent wants done outside the store until the owner
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
one that names no author, and nothing when the host's `agent_decisions` is off. `proposalRegistry`
(`./services`) is the one inbox over every kind (`relationship`, `key_document`, `fact`, `invoice`, `payment`,
`memory`, `findings`, `action`); a new kind is a `ProposalKind` that registers its id `prefix` or the stored proposal kinds it owns.
Ids are bare numbers for stored proposals and `fact:`, `invoice:`, `payment:`, `memory:`, `link:`, `key:` for the rest;
`parseProposalIds` reads ranges and lists of them; only a findings batch takes part ids (`17080/f2`). A link
keeps no actor, only provenance text, so an unconfirmed link is the owner's alone to decide, and only the owner
removes a link or writes a confirmed link of any kind (`notes.addLink`, `relate` with `by: "owner"`); an agent's
link is written unconfirmed. Only the owner removes or reverses an accepted fact; an agent withdraws only its own
proposed fact or memory. The policy is set once at `openStore({ decisions })` and read by every check. An agent's
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
