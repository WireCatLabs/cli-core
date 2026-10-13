# Plan — generated tags for notes, documents and messages, and a synonym guard

Status: **proposal, 2026-10-13. Owner direction given, design not approved.** Owner (cli-private journal
`2026-10-13-field-test-followups.md`, NEED-1005 A): generated tags are searchable at once, below the owner's;
confirming one makes it the owner's; "all of it, embeddings too".

## Goal

An agent or a rule tags notes, Drive documents and messages so that `tag:` and `search all` find them by
topic, without the owner tagging each one. The owner's tags stay apart and rank first. A new tag name that
means the same as an existing one (`seo` and «поисковая оптимизация», `semcore` and `semantic-core`) is caught
before it is created.

## Current state

Anchors on `origin/main`, 2026-10-13.

1. **Rule-made tags are already kept apart — for chats only.** `auto_tag_claims` holds a chat, a tag, the
   `algorithm`, a `score` and the matching `fields` (`src/store/sqlite/schema.ts:1352-1367`); the rules are
   keyword patterns on a channel's title and description (`src/domain/channel-tags.ts`). The owner's tags are
   `taggings` rows.
2. **The vocabulary checks new names by letter pairs.** `memo vocabulary preflight|audit` compares names with a
   bigram Dice score (`src/domain/vocabulary.ts:13-31`); the answer carries `semantic: "not-requested"`
   (`src/store/sqlite/vocabulary.ts:56`) — the place for a meaning check is reserved. Creating a tag or topic is
   the owner's (`memo vocabulary create`); an agent's request becomes a proposed action (`docs/dev/KNOWLEDGE.md`).
3. **Tag names are `a-z0-9-`, up to 32 characters** (`src/domain/tags.ts:6`). Whether a Russian project
   translates its tags is an open owner decision.
4. **Notes and documents already have vectors** (e5-small passages, `src/services/notes-search.ts`).

## Design

### Claims for every taggable thing

Generalize `auto_tag_claims` to `tag_claims`: `taggable_type`, `taggable_id` (chat, message, note, document),
`tag_id`, `algorithm` (`rules:<version>`, `vectors:<model>`, `agent:<name>`), `score`, `evidence` (fields or
the passages that matched), `status` (`claimed`, `confirmed`, `rejected`), `author`, times. Chat claims move
over unchanged.

- **Search:** `tag:x` matches the owner's taggings and live claims; a hit says which (`tagged_by: owner` or
  the algorithm), and owner taggings rank above claims of the same tag.
- **Confirm:** turns a claim into a `taggings` row by the owner. **Reject:** keeps the claim as `rejected`, so
  the same algorithm does not claim it again.
- **No new verb for an agent.** An agent's `tags add` writes a claim (as its facts wait); the owner's writes a
  tagging. `tags confirm <ref> <tag>` and `tags reject <ref> <tag>` use the glossary's words.

### Who claims

1. **Rules, at sync, no model:** a tag's aliases and keywords (kept on the vocabulary entry) matched on stems
   against the text. Cheap, explainable, runs on every new text.
2. **Vectors, at sync when vectors are made:** each tag gets a short description by the owner; a note or
   document whose passages are near the description (cosine above a measured floor) gets a claim. No extra
   model: the passages are embedded already; a tag description is one vector.
3. **An agent, on request:** reads a note or document and adds tags from the vocabulary. A name not in the
   vocabulary goes through the guard below and, if new, becomes a proposed vocabulary entry for the owner.

### Synonym guard, cheapest first

Run by `vocabulary preflight` before any new name, and by `vocabulary audit` over the whole vocabulary:

1. Normalize: case, hyphens, spaces, Unicode forms (exists).
2. Letter pairs (exists).
3. Word stems (Snowball, exists in search): `redirect` / `redirects`.
4. Edit distance against vocabulary names and aliases, with the typo corrector's code: `semcore` / `semcor`.
5. Transliteration: `seo` / `сео`, `kartochka` / `карточка` — matters while tags are Latin-only.
6. Co-occurrence: two tags on nearly the same things (overlap above a measured share) — a merge suggestion.
7. Meaning: the e5 cosine of names and descriptions; fills the reserved `semantic` field. The only layer that
   catches `seo` and «поисковая оптимизация».

Each layer reports why it flagged a pair. None merges or refuses on its own: preflight asks; audit lists.

## Cost

- **Search:** a tag is an index lookup; claims add one join. No measurable change expected; measured in
  the search benchmark before release.
- **Sync:** rules are a stem lookup per text. Vector claims compare each new passage with a few hundred tag
  vectors — microseconds per passage next to the embedding itself.
- **Creating a tag:** the meaning check embeds one name. In a CLI process that loads the model, about 1 s;
  warm (MCP server), about 10 ms (measured for e5 on queries: `cli-testing performance/search/local-documents`).

## Phases

1. `tag_claims` for chats, messages, notes and documents; `tag:` reads claims; `tags confirm|reject`;
   an agent's `tags add` claims. Guard layers 3–5.
2. Rule claims at sync from vocabulary keywords; tag descriptions.
3. Vector claims and the meaning layer; co-occurrence in `audit`. Floors measured on the owner's notes
   (private), totals to cli-testing.

## Tests

- Store: a claim and a tagging of the same tag; confirm turns one into the other; reject is not re-claimed;
  chat claims migrated.
- Search: `tag:x` finds both, owner first; the hit names who tagged it.
- Guard: tables of pairs each layer must flag and pairs it must not (`seo` / `sem`).
- An agent cannot create a vocabulary entry or a tagging of its own.

## Open questions for the owner

1. Do claims count in `tag:` filters of `search messages` too, or only in `search all` and notes search.
2. Tag descriptions: written by the owner only, or proposed by an agent and confirmed.
