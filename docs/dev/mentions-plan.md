# Plan — mentions: phones, e-mail, links, documents, names and places found in text

Status: **approved 2026-10-13 (owner, NEED-1015 A); phones in the clear (NEED-1016 B); name `mentions` (NEED-1027 A).** The owner's words (cli-private
journal `2026-10-13-field-test-followups.md`, NEED-1006): a command that pulls such values out and records
them, then an agent and a person go through them; one entity with a kind field while they are not yet
assigned, and a command to check and link them; names yes; addresses kept apart; links grouped by domain so
similar things are found; rules, not a model, by default.

## Goal

Every stored text — message, voice transcript, file text, note, Drive document — yields its **mentions**: phone
numbers, e-mail addresses, links, documents, names of people and places. Each mention is found where it was
written, normalized so two spellings meet (`+7 921 555-35-35` and `89215553535`), searchable as a field, and
waits for an agent or the owner to say what it is: this person, this organization, this document, this place,
or nothing. Questions it answers: "where did anyone send this number", "every link to this site", "who is
the Ольга in this chat", "where is the pickup point on Энгельса mentioned".

## Current state

Anchors on `origin/main`, 2026-10-13.

1. **Links are found only as text.** `has:link` filters messages with a link; a site is found by a phrase:
   `has:link AND "github.com"` (`docs/search/query-language.md:218,378`). Nothing groups links by site.
2. **Google document links are already parsed in one place.** `chats documents list <chat>` lists Google Docs
   and Drive links in a chat and stores a message → document link ([chat-documents-plan.md](chat-documents-plan.md)).
   Mentions generalize it; that command keeps its contract and reads from mentions later.
3. **A relation table exists with room for an unresolved target.** `links` has `from_type/from_id`,
   `to_type/to_id` (null until resolved), `kind`, `role`, `target_text`, `target_folded`, `confirmed`,
   `author`, and an index on unresolved targets (`src/store/sqlite/schema.ts:1370-1395`).
4. **Phone numbers are never stored in the clear.** `identities.phone_hmac` is a keyed hash, "the number
   itself never reaches a log, fixture or document"; no tool fills it yet (`docs/storage/schema.md:148`).
5. **People, organizations and their aliases exist** (`persons`, `organizations`, `aliases`), and every text
   already has Snowball stems for Russian and English/Spanish (`src/search/stem.ts:17`).

## Design

### One entity: `mentions`

A row per value found in one place of one text. Not a `links` row (owner, NEED-1023 B): `links` joins two records
the store already has (a document to a document, a person to a project); a mention is a value in a text that is
not yet any record, and may never become one.

| column | meaning |
| --- | --- |
| `id` | |
| `kind` | `phone`, `email`, `url`, `document`, `person-name`, `place` — an enum; a new kind by plan |
| `source_type`, `source_id` | the message, note, document, attachment or meeting transcript it was found in |
| `source_field` | which text of that row: `text`, `transcript`, `file_text`, `title` — a message has three |
| `start`, `end` | where in that text; the original spelling is read back from the source, never copied |
| `value` | the normalized value: E.164 phone, lower-case e-mail, URL without tracking parameters, document id, a name's lemma, a folded address |
| `domain` | `url` and `email` only: the registrable domain (`docs.google.com` → `google.com`) |
| `method`, `version` | which rule found it, so a better rule rebuilds its own rows only |
| `confidence` | the rule's own score, 0–1 |
| `status` | `found` → `linked` or `dismissed` |
| `target_type`, `target_id` | once linked: identity, person, organization, document, place, chat |
| `author` | who linked or dismissed it: the owner, or an agent by name |
| `created_at`, `updated_at` | |

Keys and indexes: unique `(source_type, source_id, source_field, start, kind)`; `(kind, value)` for `phone:` and
"everywhere this number appears"; `(domain)`; `(status, kind)` for the review list; `(target_type, target_id)` for
`mentions:<reference>`.

**A linked mention is the relation itself.** "This message mentions person 12" is the mention row with its target;
no second row in `links`, so there is one place to read and one to fix. `target_type` and `target_id` are two
columns, like every polymorphic pair in the store (`taggings`, `links`, `chunks`), not one `phone:123` string: a
string cannot be indexed by type or joined without parsing.

**Exact kinds point at one original record; the decision is made on it once** (owner, 2026-10-13, ASK-231,
NEED-1029):

- `email` → an `identities` row (`provider = email`, `external_id` = the lower-case address). 453 such rows already
  exist, each linked to a person by `identity_links`.
- `phone` → an `identities` row (`provider = phone`, `external_id` = E.164). No new table.
- `document` → the `documents` row; unresolved until the document is stored.
- `url` → no original record: `value` and `domain` already find every occurrence. A URL that names a stored thing
  points at it (`document`, `chat`).

At sync the extractor finds or creates the original and sets the mention's target at once: there is nothing to
review per occurrence, and the row starts as `linked`. "Whose number is this" is one `identity_links` row (identity → person), with its history in
`identity_link_events`; moving the number to another person changes that row, never the mentions. "Every text that
mentions Валерий" is mentions whose target is person 12, plus mentions whose target is an identity linked to person
12 — one join on indexed columns.

Rejected: one mention as the primary and the others pointing at it. The primary is itself an occurrence in a text;
an edit or a deletion removes it and breaks the chain, and choosing the primary is a decision nobody needs.

**Names and places are linked one occurrence at a time.** The text «Ольга» does not say which Ольга; two messages
in two chats can mean two people. Each name mention gets its own target (`person` or `place`). `mentions show`
offers the people with that name met in the same chat first, and `mentions confirm --chat` links every «Ольга» of
one chat to one person in one step — still one target per row, so one wrong chat is fixed alone.

**Edits and rebuilds.** An edited text rebuilds its mentions; a decision survives: a `linked` or `dismissed` status
is carried to the new row with the same `kind`, `value` and source. A rule `version` bump rebuilds only its kind.

### `places`

| column | meaning |
| --- | --- |
| `id` | |
| `address` | as the owner wrote or confirmed it |
| `folded` | lower-case, abbreviations expanded (`ул.` → `улица`), for matching mentions |
| `latitude`, `longitude` | optional; never fetched from an outside service without asking |
| `author`, `created_at`, `updated_at` | |

A person or an organization relates to a place through `links` (`located-at`) — that is a relation between two
records, which is what `links` holds.

### What finds each kind — rules, no model

| kind | how | precision expected |
| --- | --- | --- |
| `phone` | [`libphonenumber-js`](https://github.com/catamphetamine/libphonenumber-js) `findPhoneNumbersInText`, default country from the account, `min` metadata (~80 kB); stored as E.164 | high |
| `email` | one tested pattern; lower-cased; domain through `tldts` | high |
| `url` | a URL pattern plus bare domains with a known suffix; normalized (scheme, host lower-cased, `utm_*`, `fbclid`, fragment dropped); [`tldts`](https://github.com/remusao/tldts) gives `domain` from the public suffix list | high |
| `document` | known URL shapes: Google Docs/Sheets/Drive ids today (the chat-documents parser), later Notion, GitHub | high |
| `person-name` | (a) names and aliases of known people and contacts, matched on stems, so `Валерию` finds Валерий; (b) unknown names: a first-name list plus patronymic endings (`-ович`, `-овна`, …) and capitalization | (a) high, (b) medium |
| `place` | address grammar: markers (`ул.`, `улица`, `пр-т`, `д.`, `кв.`, `г.`, a six-digit postcode) around a capitalized name and a number | medium |

Unknown names and places are the weak kinds. They start as `found` with a lower confidence and are never
shown as facts until linked. A language model may later re-check them — optional, per run, never by default.

### Links grouped by site

- `domain` makes every link to one site one group; `subdomain` and path are kept in `value`.
- `links domains list` (proposed) — sites by number of links, with first and last time seen.
- "Similar": the same domain, then the same first path segment (`github.com/WireCatLabs/…`).
- A link to a stored thing resolves: a Google document id → `document:<id>`, a `t.me/<chat>` link → the chat.

### Phones and privacy

The owner chose digits in the store (NEED-1016 B), so `mentions list --kind phone` can list every number. A
phone mention's `value` is the E.164 form, and so is its `phone` identity's `external_id`. A messenger identity
that has only `phone_hmac` (a Telegram contact) is matched by hashing the E.164 value with the same key; a match
links the `phone` identity to that contact's person. The store is the owner's and already holds the digits in
message text; what stays the rule: no number in a log, an error, a fixture, a test or a document — tests use
reserved fictional numbers.

### When it runs

- During `messages sync`, `memo sync` and drive's sync, on the texts they add or change — the same pass that
  writes stems. A rebuild per kind when a rule's `version` changes.
- One explicit pass for what is already stored (proposed `mentions rebuild [--kind]`), resumable, with
  progress.

### Search

New fields, each in STANDARD first: `phone:`, `email:`, `url:`, `domain:`, `mentions:<reference>`
(texts that mention this person, organization, place or document — linked mentions only). `search all`
returns a mention's source with `match: "mention"`.

### Review — agent and owner

Proposed commands; words go through the glossary and STANDARD first (`extract` already means "read the text of
files", so it is not used here):

```text
mentions list [--kind <k>] [--status found|linked|dismissed] [--domain <d>] [--source <ref>]
mentions show <id>               the mention, its source text around it, candidate targets
mentions confirm <id> <ref>      link it to a person, organization, document or place
mentions reject <id>             not a real mention, or not worth keeping
mentions rebuild [--kind <k>]    find mentions in what is already stored
links domains list               sites by number of links
places list | show | add         addresses as their own records
```

Exact kinds need no confirm per mention (above). An agent's link of a `phone` or `email` identity to a person is
final when the match is exact — the same number in the person's contact card or `phone_hmac` (owner, NEED-1026 A);
an agent's link of a name or a place waits for the owner, as its facts do. The owner's is final. `mentions show`
offers candidates: known people whose name matches the stem, the identity whose `phone_hmac` equals the mention's.

## Cost

Rules run where stems already run. Expected (not measured): phone and URL search are linear in text length;
name matching is a lookup per capitalized word. Measure on the owner's store before the release: time added
to `messages sync` and a full `mentions rebuild`, rows per 1,000 messages, store growth. Search by a field is
an index lookup.

## Phases

1. `phone`, `email`, `url` with `domain`, `document` — the high-precision kinds; fields `phone:`, `email:`,
   `url:`, `domain:`; `links domains list`; `mentions list|show|confirm|reject|rebuild`.
2. `person-name` for known people (stems against names and aliases); `mentions:<reference>`.
3. Unknown names and `place`, with `places`; precision measured on a labelled sample of the owner's chats
   (results private, totals to cli-testing).

## Tests

- Each detector: tables of real-world spellings (Russian and international phones, URLs with tracking and
  Cyrillic domains, e-mail in brackets, names in six cases), and texts that must yield nothing.
- A store test: sync writes mentions, an edited message replaces them, a deleted one removes them; a rule
  version bump rebuilds only its kind.
- Privacy: no phone digits in logs or errors; fixtures use fictional numbers only.
- Search: `phone:` in two spellings finds the same messages; `domain:` groups subdomains.

## Open questions for the owner

1. ~~The entity's name~~ — `mentions` (owner, 2026-10-13, NEED-1027 A).
2. ~~Phones stored as HMAC only or also in the clear~~ — in the clear (owner, 2026-10-13, NEED-1016 B).
3. ~~Rows in `links` or a table of its own~~ — its own table (owner, 2026-10-13, NEED-1023 B).
4. ~~Linking by value~~ — replaced by original records: phones and e-mail are `identities`, linked to a person
   once (owner's direction, ASK-231); confirming `provider = phone` in `identities` is NEED-1029.
5. ~~An agent's confirm of exact kinds~~ — final on an exact match; names and places wait (owner, NEED-1026 A).
