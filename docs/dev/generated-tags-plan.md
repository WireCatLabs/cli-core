# Plan — generated tags for notes, documents and messages, and a synonym guard

Status: **approved 2026-10-13 (owner, NEED-1017 A): `tags.folded` is unique.** Owner (cli-private
journal `2026-10-13-field-test-followups.md`, NEED-1005 A, NEED-1017 and its review): generated tags are
searchable at once, below the owner's; confirming one makes it the owner's; "all of it, embeddings too"; tags in
any language, checked for duplicates through a transliterated form; no second table where a column will do; a
model (local, OpenAI or Anthropic) or an agent may set tags.

## Goal

An agent, a model or a rule tags notes, Drive documents and messages so that `tag:` and `search all` find them by
topic, without the owner tagging each one. The owner's tags rank first. A new tag that means the same as an
existing one (`seo`, `сео`, «поисковая оптимизация»; `semcore` and `semantic-core`) is caught before it is
created.

## Current state

Anchors on `origin/main` 8a30bc29, 2026-10-13.

1. **Two tables hold the same relation.** `taggings` is polymorphic (`tag_id`, `taggable_type`, `taggable_id`),
   with `source`, `author_type`, `author_id` and `main` (`src/store/sqlite/schema.ts:1424-1445`). Rule-made chat
   tags live apart in `auto_tag_claims` (`chat_id`, `tag_id`, `algorithm`, `score`, `fields`;
   `schema.ts:1352-1367`), filled by keyword rules on a chat's title and description
   (`src/domain/channel-tags.ts`).
2. **Tag names are `a-z0-9-`, up to 32 characters** (`src/domain/tags.ts:6`), lower-cased.
3. **The vocabulary checks new names by letter pairs** (bigram Dice, `src/domain/vocabulary.ts:13-31`) for
   projects, tags and topics; its answer carries `semantic: "not-requested"` (`src/store/sqlite/vocabulary.ts:56`).
4. **Notes and documents already have vectors**: e5-small passages in the shared `chunks` and `embeddings` tables.
   How vectors are made is planned apart: [embedding-registry-plan.md](embedding-registry-plan.md).

## Design

### One table: `taggings`

A generated tag is a `taggings` row, not a row in another table. New columns:

| column | meaning |
| --- | --- |
| `status` | `confirmed` (the owner's, every row today) · `claimed` (generated, not yet seen) · `rejected` |
| `algorithm` | `rules:<version>`, `vectors:<model>`, `model:<provider>:<model>`, `agent:<name>`; null for the owner's |
| `score` | the algorithm's own score, 0–1; null for the owner's |
| `evidence` | the fields or passages that matched, as JSON; never message text copied into logs |

- `source`, `author_type`, `author_id` keep their meaning: who wrote the row.
- `auto_tag_claims` moves into `taggings` (`status = claimed`, `algorithm`, `score`, `fields` → `evidence`) and is
  dropped in the same migration.
- The unique key `(tag_id, taggable_type, taggable_id)` stays: one thing has one row per tag. **Confirm** updates a
  claim to `confirmed` and makes the owner its author; **reject** sets `rejected`, so no algorithm claims it again.
- A claim never sets `main = 1` (the main topic stays the owner's).
- **The cost:** about 30 reads of `taggings` in 10 files assume every row is the owner's (`src/store/sqlite/tags.ts`
  13, `lucene.ts` 3, `note-search.ts` 3, `chats.ts` 2, `accounts.ts` 2, and one each in five more). Each read
  names the statuses it wants; a store test fails when a read path returns a `claimed` or `rejected` row where
  only confirmed ones belong.

### Search

- `tag:x` matches `confirmed` and `claimed` rows; owner rows rank above claims of the same tag; each hit says
  who tagged it (`tagged_by: owner` or the algorithm). `rejected` rows never match.
- `tags list` shows claims apart from the owner's tags, with counts.

### Tags in any language

- The `a-z0-9-` rule goes (a STANDARD PR, and `tag:` in the query language accepts any letters). A tag keeps the
  spelling it was created with, lower-cased.
- A new column `tags.folded`: the name lower-cased, Unicode-normalized, transliterated to Latin (one fixed table,
  GOST-like: `сео` → `seo`, `карточка` → `kartochka`), hyphens and spaces removed. It is what the duplicate check
  compares and what `tag:` also matches, so `tag:сео` finds `seo`.
- `folded` is a unique index: two tags can never fold to one form; preflight names the existing tag.

### Who sets tags

1. **Rules, at sync, no model:** a tag's aliases and keywords (on the vocabulary entry) matched on stems.
2. **Vectors, at sync when vectors are made:** a tag's name and description get one vector; a note or document
   whose passages are near it (cosine above a measured floor) gets a claim. No extra model.
3. **A model, on request:** `tags suggest <ref|query> --model <provider:model>` sends the text to a model with the
   vocabulary and records claims (`algorithm = model:<provider>:<model>`). A local model runs on this machine;
   OpenAI or Anthropic receive the owner's text, so a remote model is named on every run — never a default, never
   chosen by the tool — and uses the embedding keys already kept per provider (`src/cli/embedding-keys.ts`).
4. **An agent:** reads the thing itself and calls `tags add`; an agent's `tags add` writes a claim, the owner's a
   confirmed row. No new dependency.

A name not in the vocabulary, from 3 or 4, goes through the guard and becomes a proposed vocabulary entry for the
owner; it is never created by a model or an agent.

### Synonym guard, cheapest first

Run by `vocabulary preflight` before any new name, and by `vocabulary audit` over the whole vocabulary:

1. Normalize: case, hyphens, spaces, Unicode forms (exists).
2. Letter pairs (exists).
3. Transliteration: compare `folded` forms: `seo` / `сео`.
4. Word stems (Snowball, exists in search): `redirect` / `redirects`, `карточка` / `карточки`.
5. Edit distance on `folded`, with the typo corrector's code: `semcore` / `semcor`.
6. Co-occurrence: two tags on nearly the same things — a merge suggestion.
7. Meaning: e5 cosine of names and descriptions; fills the reserved `semantic` field. The only layer that catches
   `seo` and «поисковая оптимизация». Tag to tag is a symmetric comparison, so both sides take the `query: `
   prefix, as the [e5 model card](https://huggingface.co/intfloat/multilingual-e5-small) prescribes for semantic
   similarity.

Each layer reports why it flagged a pair. None merges or refuses on its own: preflight asks; audit lists.

## Cost

- **Search:** a tag is an index lookup; the status filter adds one column to it.
- **Sync:** rules are a stem lookup per text; vector claims compare each new passage with a few hundred tag
  vectors — microseconds next to the embedding itself.
- **Creating a tag:** the meaning check embeds one name; about 1 s in a CLI process that loads the model, about
  10 ms warm (measured for e5 on queries: `cli-testing performance/search/local-documents`).
- **A model run:** the model's own time and, for a remote one, its price; on request only.

## Phases

1. `taggings.status|algorithm|score|evidence`, `auto_tag_claims` moved in; every read names its statuses;
   `tags confirm|reject`; an agent's `tags add` claims. Any-language names with `tags.folded`; guard layers 3–5.
2. Rule claims at sync from vocabulary keywords; tag descriptions; `tags suggest --model`.
3. Vector claims and the meaning layer through the embedding registry; co-occurrence in `audit`. Floors measured
   on the owner's notes (private), totals to cli-testing.

## Tests

- Store: a claim and a confirmed tag; confirm and reject; reject is not re-claimed; chat claims migrated; a read
  path that should see only confirmed rows does.
- Search: `tag:x` finds both, owner first; `tag:сео` finds `seo`; the hit names who tagged it.
- Guard: tables of pairs each layer must flag and pairs it must not (`seo` / `sem`).
- A model or an agent cannot create a vocabulary entry or a confirmed tagging.
- A remote model is never called without `--model` naming it.

## Open questions for the owner

1. ~~`tags.folded` unique or a warning only~~ — unique (owner, 2026-10-13, NEED-1017 A).
2. Do claims count in `tag:` filters of `search messages` too, or only in `search all` and notes search.
3. Tag descriptions: written by the owner only, or proposed by an agent and confirmed.
