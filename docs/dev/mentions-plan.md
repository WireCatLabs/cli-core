# Plan — mentions: phones, e-mail, links, documents, names and places found in text

Status: **proposal, 2026-10-13. Owner direction given, design not approved.** The owner's words (cli-private
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

A row per value found in one place of one text.

| column | meaning |
| --- | --- |
| `kind` | `phone`, `email`, `url`, `document`, `person-name`, `place` — an enum; new kinds by plan |
| `source_type`, `source_id` | the message, transcript, file text, note or document it was found in |
| `start`, `end` | where in that text: the original spelling is read back from the source, never copied |
| `value` | the normalized value: URL without tracking parameters, lower-case e-mail, a name's lemma; for a phone, the HMAC (below) |
| `domain` | for `url` and `email`: the registrable domain (`docs.google.com` → `google.com`, `www.example.co.uk` → `example.co.uk`) |
| `method`, `version` | which rule found it, so a better rule can rebuild its own rows only |
| `confidence` | the rule's own score, 0–1 |
| `status` | `found` → `linked` or `dismissed` |
| `target_type`, `target_id` | once linked: identity, person, organization, document, place |
| `author` | who linked or dismissed it: the owner, or an agent by name (as facts record it) |

Why a table of its own, not rows in `links`: volume (every link in 100,000 messages), its own indexes
(`kind, value`; `domain`; `status`), and a review state that `links` does not have. A linked mention also
writes the `links` row that relation needs, so relations stay where they are read today.

### What finds each kind — rules, no model

| kind | how | precision expected |
| --- | --- | --- |
| `phone` | [`libphonenumber-js`](https://github.com/catamphetamine/libphonenumber-js) `findPhoneNumbersInText`, default country from the account, `min` metadata (~80 kB); E.164 then HMAC | high |
| `email` | one tested pattern; lower-cased; domain through `tldts` | high |
| `url` | a URL pattern plus bare domains with a known suffix; normalized (scheme, host lower-cased, `utm_*`, `fbclid`, fragment dropped); [`tldts`](https://github.com/remusao/tldts) gives `domain` from the public suffix list | high |
| `document` | known URL shapes: Google Docs/Sheets/Drive ids today (the chat-documents parser), later Notion, GitHub | high |
| `person-name` | (a) names and aliases of known people and contacts, matched on stems, so `Валерию` finds Валерий; (b) unknown names: a first-name list plus patronymic endings (`-ович`, `-овна`, …) and capitalization | (a) high, (b) medium |
| `place` | address grammar: markers (`ул.`, `улица`, `пр-т`, `д.`, `кв.`, `г.`, a six-digit postcode) around a capitalized name and a number | medium |

Unknown names and places are the weak kinds. They start as `found` with a lower confidence and are never
shown as facts until linked. A language model may later re-check them — optional, per run, never by default.

### Places are their own entity

The owner wants addresses kept apart. A linked `place` mention points at a `places` row: the address as written
by the owner, a normalized form, and optional coordinates, never fetched without asking. Persons and
organizations relate to places through `links` (`located-at`).

### Links grouped by site

- `domain` makes every link to one site one group; `subdomain` and path are kept in `value`.
- `links domains list` (proposed) — sites by number of links, with first and last time seen.
- "Similar": the same domain, then the same first path segment (`github.com/WireCatLabs/…`).
- A link to a stored thing resolves: a Google document id → `document:<id>`, a `t.me/<chat>` link → the chat.

### Phones and privacy

A phone mention's `value` is the HMAC with the key `phone_hmac` uses, so a mention links to an identity by
equal hashes and `phone:+79215553535` hashes the query before it searches. The digits stay only in the source
text, which the store holds anyway. Nothing writes the number to a log, an answer's metadata or a fixture.

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

An agent's `confirm` waits for the owner, as its facts do; the owner's is final. `mentions show` offers
candidates: known people whose name matches the stem, the identity whose `phone_hmac` equals the mention's.

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
- Privacy: no phone digits in `mentions`, in any JSON answer's metadata, or in logs.
- Search: `phone:` in two spellings finds the same messages; `domain:` groups subdomains.

## Open questions for the owner

1. The entity's name: `mentions` (proposed) or another word.
2. Phones stored as HMAC only (proposed) or also in the clear in the store.
3. Should an agent's `confirm` of an obvious kind (a document id, an exact known phone) count without the
   owner, or wait like its facts.
