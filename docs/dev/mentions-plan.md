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

**Exact kinds: the value is the key; the original record is the identity, made only when it has an owner**
(owner, 2026-10-13, ASK-231, ASK-232, NEED-1031 A):

- A person or an organization has many ways to reach it (an organization since NEED-1032 A) — e-mail addresses, phones, messenger accounts. Each is
  one `identities` row; `identity_links` gives the row its owner (one owner per identity, many identities per
  owner). The schema allows this today; the data does not use it yet: each of the 541 linked identities in the
  owner's store has a person of its own, and no person has two (FIND-1194).
- A phone or an e-mail mention does not create an identity. Its `value` (E.164, lower-case address) is as exact as
  an id: "where is this number" is the `(kind, value)` index; "where is Валерий's number" joins his identities
  to mentions on `(provider, external_id) = (kind, value)`. Nothing is copied, so moving a number to another
  person changes one `identity_links` row and no mention.
- An identity is created when a number or an address gets an owner (`mentions confirm <id> person:12`), or when a
  messenger already knows it. Numbers nobody owns stay mentions only: 31 reads of `identities` in 18 files
  (contacts, roster, rankings, retention) treat an identity as someone met, and thousands of shop and courier
  numbers from texts would fill them.
- `phone` is a new `provider`; `email` exists (453 rows).
- `document` → the `documents` row; `url` → no original record (`value` and `domain`), or the stored document or
  chat it names. These two set the mention's target at sync.

Rejected: one mention as the primary and the others pointing at it. The primary is itself an occurrence in a text;
an edit or a deletion removes it and breaks the chain, and choosing the primary is a decision nobody needs.

**Names and places are linked one occurrence at a time.** The text «Ольга» does not say which Ольга; two messages
in two chats can mean two people. Each name mention gets its own target (`person` or `place`). `mentions show`
offers the people with that name met in the same chat first, and `mentions confirm --chat` links every «Ольга» of
one chat to one person in one step — still one target per row, so one wrong chat is fixed alone.

**An organization owns an identity** in a table of its own, `organization_identities` (owner, NEED-1065): a
shop's number, `info@`. It is apart from `identity_links`, which says which person an identity is, so one number
can be both someone's and their company's, and organizations link to documents and the rest through `links` as
before. The migration adds the table; nothing is rebuilt.

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
| `phone` | our own rules, no library (owner, NEED-1033): see [Phones by rule](#phones-by-rule) | medium; a number-like order id is a cheap mistake, `dismissed` once |
| `email` | one tested pattern; lower-cased; domain through `psl` | high |
| `url` | a URL pattern plus bare domains with a known suffix; normalized (scheme, host lower-cased, `utm_*`, `fbclid`, fragment dropped); [`psl`](https://github.com/lupomontero/psl) gives `domain` from the public suffix list (0.7 MB; owner, NEED-1034) | high |
| `document` | known URL shapes: Google Docs/Sheets/Drive ids today (the chat-documents parser), later Notion, GitHub | high |
| `person-name` | (a) names and aliases of known people and contacts, matched on stems, so `Валерию` finds Валерий; (b) unknown names: a first-name list plus patronymic endings (`-ович`, `-овна`, …) and capitalization | (a) high, (b) medium |
| `place` | address grammar: markers (`ул.`, `улица`, `пр-т`, `д.`, `кв.`, `г.`, a six-digit postcode) around a capitalized name and a number | medium |

### Phones by rule

The aim is "looks like a phone", not a perfect list: a wrong candidate costs one `dismissed`, a missed one costs
a search that finds nothing. No library: `libphonenumber-js` installs 10 MB for checks this does not need.

1. **Candidate:** an optional `+`, then 7–15 digits split only by spaces, `-`, `.` or brackets, not glued to a
   letter, a digit, `/` or `@` (so not inside a URL, an e-mail or a longer number).
2. **Kept when** it is written like a phone (a `+`, brackets, or groups split the way phones are), or is a bare
   Russian mobile (`89…`/`79…` with 11 digits, `9…` with 10), or a phone word stands just before it (`тел`,
   `телефон`, `моб`, `phone`, `tel`, `whatsapp`, `звони`).
3. **Dropped when** it is a date or a time (`12.10.2026`, `2026-10-12`), a sum (a currency sign or word next to
   it), a card number (13–19 digits that pass the Luhn check), an IP address, or an order, invoice or tax number
   (`№`, `заказ`, `счет`, `order`, `ИНН`, `ОГРН`, `БИК`, `р/с` just before it).
4. **Value:** with `+` → `+` and the digits; 11 digits from `8` or `7` → `+7` and the last 10; 10 digits from `9` →
   `+7` and the digits; anything else → the digits alone, no `+`, and `confidence` lower. The account has no
   country, so no other country is guessed.
5. **Confidence:** written like a phone or after a phone word — 0.9; a bare Russian mobile — 0.7; digits alone —
   0.5.

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
mentions rebuild [--kind <k>]    find mentions in what is already stored; `rebuild` is a new verb in cli-base's
                                 registry: compute again from what the store holds (owner, NEED-1035 B)
links domains list               sites by number of links
places list | show | add         addresses as their own records
```

A phone or an e-mail is confirmed once per value: `confirm` finds or creates the identity and gives it its owner,
and every mention of that value follows (above). An agent's link of a `phone` or `email` identity to a person is
final when the match is exact — the same number in the person's contact card or `phone_hmac` (owner, NEED-1026 A);
an agent's link of a name or a place waits for the owner, as its facts do. The owner's is final. `mentions show`
offers candidates: known people whose name matches the stem, the identity whose `phone_hmac` equals the mention's.

Who decided is the author rule memo uses (`authorOf`, `src/cli/author.ts`): the agent named by `AI_AGENT` or
`CLAUDECODE`, else the owner; `--as-owner` records the owner. A value that already has an original when it is
written — an identity with an owner, the stored document — starts as `linked` with author `rules`; a value
dismissed anywhere starts as `dismissed`. A link (`url`) is only rejected for now: there is nothing to link it to
until 1d resolves links to stored documents and chats.

## Cost

Rules run where stems already run. Expected (not measured): phone and URL search are linear in text length;
name matching is a lookup per capitalized word. Measure on the owner's store before the release: time added
to `messages sync` and a full `mentions rebuild`, rows per 1,000 messages, store growth. Search by a field is
an index lookup.

## Phases

1. **1a, 1b — built** (0.264.0 and this release): `mentions list|show|rebuild|confirm|reject`, message text.
   **1c** — organizations own identities: built (store version 11, `organization_identities`).
   **1d** — fields `phone:`, `email:`, `url:`, `domain:` in `search messages`: built. Still to come: links resolved
   to stored documents and chats, and `links domains list` (sites by number of links).
   **1e** — the other texts: file texts and voice transcripts built (store version 10); notes, documents and mail
   to come.
2. `person-name` for known people (stems against names and aliases); `mentions:<reference>` — built: people met
   in a messenger, a meeting or a confirmed phone, not the e-mail-only ones; a Latin name transliterated; a stem or
   the written name plus up to three letters of ending; a rule link only to the one fitting person who wrote in the
   chat; `mentions rebuild <kind>`. Builds of 0.264–0.270 delete a text's `person-name` rows when they read it
   again (they deleted every kind); from this one, a build keeps the kinds it does not know.
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

None.
