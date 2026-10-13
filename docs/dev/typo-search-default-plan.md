# Plan: typo-tolerant search by default, without `--language legacy`

Status: approved by the owner on 2026-10-13 — option B. Strict first; only when strict finds
nothing, one-edit corrections and 3+ letter beginnings, each forgiven hit labelled. Partial matches
stay opt-in through `--discover`. When B finds nothing, MCP points at `discover=true` through the
existing `next_steps` key (`src/mcp/tool.ts:96-97`, `:290`); the CLI prints one stderr line. No new
key. Service code waits for the plain-search-coverage change (see Dependency).

## Goal

A plain search forgives typos and unfinished words by default. `--language legacy` goes away.
Strict Lucene syntax stays. `--exact` keeps "no forgiveness". Every forgiven hit says how it matched.

## Current state

- CLI and MCP default to strict Lucene. The service sets `language: "lucene"` when none is given
  (`src/services/messages.ts:492`). Legacy is explicit: `--language <lucene|legacy>`
  (`src/cli/messenger/messages-search-command.ts:74`, `src/cli/messenger/searches-command.ts:46`),
  MCP `language` (`src/mcp/tools/search.ts:74`).
- The SDK entry `searchStore` without a language still runs the legacy chain
  (`src/services/messages.ts:820`). `bot search messages` calls it that way
  (`src/cli/bot/people.ts:223`).
- Parser hints send users to legacy for typos (`src/search/lucene/parser.ts:256`,
  `src/search/lucene/registry.ts:424`). The user guide says the same
  (`docs/search/query-language.md:1-60`).
- `searchCombined` (`src/services/messages-combined.ts:33`) already merges word, beginning and
  corrected candidates for implicit-AND plain words (`:65-76`). It is internal. `--discover`
  uses it inside a broader partial search (`src/services/messages-discovery.ts:51-62`).
- Correction reads only the message-text vocabulary (`src/store/sqlite/words.ts:306`).
  `knownTerms` counts a word *beginning* as known (`words.ts:312`), so "is this a whole archive word"
  needs its own check.
- The default-switch gates are fixed in [combined-search.md](combined-search.md#evidence-and-acceptance-targets)
  (lines 40-50). The release order is in [the same file](combined-search.md#compatibility-and-release-order).
- Saved legacy searches convert through `migrateLegacyQuery` (`src/search/lucene/migration.ts:22`),
  which quotes every term. That turns forgiveness off.

## What was measured

The [message benchmark](https://github.com/WireCatLabs/cli-testing/blob/06e23a1/performance/search/message-search/README.md#typo-forgiveness-only-when-strict-finds-nothing):
2,616 synthetic messages, 48 queries per split, a temporary store. No real store.

- cli-testing `origin/main` (contains 63de1d78, package scope `@wirecat`) runs against today's
  cli-messaging. Branch `test/search-experiments` still uses the old `@leemour` scope and does not.
- The new runner is on cli-testing branch `test/typo-search-narrow`, commit `a82bf93`
  ([cli-testing#37](https://github.com/WireCatLabs/cli-testing/pull/37)).
- Measured build: cli-messaging `0cc88b1f` (origin/main). Runner sha256 `a7ab3a2b…`, corpus
  `31ffb868…`, `messages-combined.js` `cb8f4c25…`; all hashes are in the result files.

Variants:

- **strict** — today's CLI default.
- **legacy** — `--language legacy`.
- **combined (A)** — `searchCombined` with its defaults: word, beginning and corrected lists fused.
- **discover** — today's `--discover`.
- **narrow (B)** — strict first. Only when strict returns nothing, each plain word that is not a whole
  archive word gets help: a known beginning becomes `word*`; an unknown word becomes its nearest
  archive words. The words are rewritten into the query (`aurora (rollout) rollback`,
  `aurora (roll*) rollback`) and strict runs once more. Frozen guard: one edit, no frequency
  floor, beginnings of 3+ letters. Dev tied on beginnings of 3 or 4 letters and on every frequency
  floor; 3 is production's existing threshold, and the floor changed nothing.
- **combined when strict is empty** — also measured: strict first, then `searchCombined`. Same
  quality as B, but p95 34.3 ms and 41 near-word hits, because `correctWords` allows two edits
  above four letters (`src/search/correct.ts:17`).
- **C — B plus a partial fallback.** Only when B still finds nothing: a partial-word search, each hit
  listing its missing words. Three fallbacks on dev: any word (`(a OR b OR c)`), all but one word,
  and the production `--discover` path. Frozen choice: `--discover`, the only one equal to legacy.

Reproduce (from the cli-testing worktree):

```sh
export SEARCH_MESSAGING_ROOT=/absolute/path/to/cli-messaging   # built with pnpm build
python3 performance/search/run.py --messaging-root "$SEARCH_MESSAGING_ROOT" typecheck
python3 performance/search/run.py --messaging-root "$SEARCH_MESSAGING_ROOT" typo > /tmp/typo-dev.json
python3 performance/search/run.py --messaging-root "$SEARCH_MESSAGING_ROOT" typo --held-out \
  '--frozen={"edits":"one","minDocs":1,"prefix":3}' --partial=discover > /tmp/typo-heldout.json
```

### Dev split (tuning)

| Variant | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits | Typo recall | Beginnings recall | Paraphrase recall | Near-word hits | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| strict | 0.313 | 0.325 | 0.287 | 0 / 80 | 0.000 | 0.000 | 0.000 | 0 | 10.5 |
| legacy | 0.388 | 0.425 | 0.354 | 80 / 80 | 0.250 | 0.250 | 0.250 | 41 | 5.9 |
| combined (A) | 0.362 | 0.375 | 0.326 | 0 / 80 | 0.250 | 0.250 | 0.000 | 41 | 34.1 |
| discover | 0.362 | 0.425 | 0.328 | 80 / 80 | 0.125 | 0.125 | 0.250 | 50 | 44.3 |
| narrow (B) | 0.362 | 0.375 | 0.326 | 0 / 80 | 0.250 | 0.250 | 0.000 | 10 | 11.0 |
| C, any-word fallback | 0.375 | 0.400 | 0.333 | 80 / 80 | 0.250 | 0.250 | 0.125 | 50 | 12.1 |
| C, all-but-one fallback | 0.375 | 0.400 | 0.347 | 40 / 80 | 0.250 | 0.250 | 0.125 | 50 | 16.1 |
| C, `--discover` fallback | 0.388 | 0.425 | 0.354 | 80 / 80 | 0.250 | 0.250 | 0.250 | 50 | 28.0 |
| gate | ≥ 0.45 | ≥ 0.50 | ≥ 0.40 | 0 | > legacy | > legacy | reported | — | ≤ 3× strict |

### Held-out split (one run of the frozen guard; informational)

| Variant | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits | Typo recall | Beginnings recall | Paraphrase recall |
|---|---|---|---|---|---|---|---|
| strict | 0.263 | 0.325 | 0.219 | 0 / 80 | 0.000 | 0.000 | 0.000 |
| legacy | 0.338 | 0.450 | 0.299 | 80 / 80 | 0.125 | 0.125 | 0.500 |
| combined (A) | 0.275 | 0.350 | 0.226 | 0 / 80 | 0.000 | 0.125 | 0.000 |
| discover | 0.325 | 0.403 | 0.274 | 80 / 80 | 0.125 | 0.125 | 0.375 |
| narrow (B) | 0.275 | 0.350 | 0.226 | 0 / 80 | 0.000 | 0.125 | 0.000 |
| C, `--discover` fallback | 0.312 | 0.400 | 0.272 | 80 / 80 | 0.000 | 0.125 | 0.375 |

This split was already read by the reranker experiment. By the rule in
[combined-search.md](combined-search.md#evidence-and-acceptance-targets) (lines 52-55) it cannot
qualify a release. It is reported so the dev result is not read alone.

### What the numbers say

1. **Forgiveness works; ranking is the gap.** A typo or a beginning now returns the same top ten as
   the correctly spelled query: 8 of 8 on dev, 7 of 8 on held-out, for both A and B. Typo recall
   is 0.25 because the correctly spelled query also scores 0.25 (0.125 on held-out). The
   300 distractors per topic share the words. No typo rule can lift that; only ranking can.
2. **B equals A on quality and costs nothing on hits strict already finds.** When strict returns
   hits, B returns exactly them. Phrase, AND/OR, chat, sender and date queries are identical to
   strict for A and B. B's p95 is about strict's; A's is 3.2× strict on this run (2.8-4× across
   earlier runs). The corpus is small; no 100k-message latency is measured.
3. **Zero no-answer hits is weak evidence.** The benchmark's no-answer words (`quantum`, `unicorn`,
   `purple`) have no near word in the archive, so no correction ever fires on them.
4. **Corrections fire on real words that are simply not in the archive.** Six unlabelled
   `absent-near-word` queries were added after the first sweep, so they are a diagnostic, not a gate.
   `cedar backup detention` becomes `retention` under one edit and returns ten hits. Two edits
   (production's rule for words over four letters) fire on all five queries (41 hits). The held-out run
   also corrected a real word, `схемы` → `схему`, in a paraphrase query. A frequency floor
   (1, 2, 3, 5 or 10 messages) changed nothing: a common archive word is always the nearest.
   The search cannot tell a typo from an absent word. Only visible labelling makes this safe.
5. **"Strict found nothing" has a blind spot.** `вектор миграця отмена` (held-out) gets ten strict
   hits because the stemmer matches the typo `миграця`. B never fires, and the stem-matched ranking
   misses both answers. That is the one held-out parity miss.
6. **The benchmark has no one-word queries.** "Single words with no exact hit" is read here per
   word inside an implicit-AND query. Read literally (a query of exactly one word), the rule fires
   on zero benchmark queries and gains nothing measurable.
7. **Why B loses to legacy.** Per category on dev, B equals legacy everywhere except paraphrase
   (legacy 0.25, B 0). A paraphrase answer lacks one or more query words. Legacy's any-word fallback
   still returns it, and on every query with no full match it fills the page: that is the
   80 / 80 no-answer false hits. The extra recall and the false hits are the same mechanism.
8. **C buys legacy's quality with legacy's false hits.** The `--discover` fallback equals legacy in
   every dev category and on all three averages, with 80 / 80 no-answer hits (each one labelled
   with its missing words). All-but-one halves the false hits (40) but loses half the paraphrase
   gain. On held-out C stays below legacy in typo and paraphrase. The stemmer blind spot still
   costs typo recall there: legacy and `--discover` get 0.5 on `вектор миграця отмена`; B and C get 0,
   because strict's stem match is not empty, so neither the correction nor the fallback runs.
9. **Today's `--discover` has 80 / 80 no-answer hits.** It is a partial-match tool by design; it is
   not a replacement for the default.

## Gates

| Gate (combined-search.md:40-50) | A: combined | B: narrow |
|---|---|---|
| Recall ≥ 0.45, MRR ≥ 0.50, nDCG ≥ 0.40 (dev) | fail (0.362 / 0.375 / 0.326) | fail (same) |
| Beat strict and legacy on all three | fail: beats strict, loses to legacy | fail (same) |
| Zero no-answer false hits | pass, weak (point 3) | pass, weak (point 3) |
| Sender/date recall 1.0; phrase and Boolean identical to strict | pass | pass |
| Typo and beginnings recall above legacy | fail: equal on dev | fail: equal on dev, below on held-out typo |
| Every combined hit labelled | pass (`match`, `matches`) | not yet: the prototype is unlabelled (work item 3) |
| Strict results unchanged for the same query | pass for explicit syntax | pass for every query strict answers |
| Latency p95 ≤ 250 ms and ≤ 3× strict | fails at small scale (3.2× strict); 100k not measured | ≈ 1× strict at small scale; 100k not measured |

B's numbers come from the query rewrite described above, not from `searchCombined`.
Neither option passes the gates as written. The three quality gates measure ranking, and both
options leave ranking where strict has it.

## Options

C (B plus a partial fallback) is measured above. It reaches legacy on dev only by repeating legacy's
no-answer hits, so it fails the zero-false-hit gate the same way legacy does.


**A — full switch through the gates.** Make `searchCombined` the default for every plain word. It
needs a ranking change that passes the quality gates first. The only measured candidate is the
query-message reranker (dev 0.525 / 0.553 / 0.477), which missed held-out recall and MRR and costs
3-4 s per query. A blocks typo forgiveness on unsolved ranking work.

**B — narrow first step under its own gates.** Ship B as the default now. Keep the ranking gates
for a later ranking change. Proposed gates for B, to approve before coding:

1. Every query strict answers returns exactly strict's hits and order.
2. Typo and beginning queries return the correctly spelled query's top ten (dev 8/8 today).
3. Zero no-answer false hits on the benchmark, and the absent-near-word diagnostic reported, not hidden.
4. Every forgiven hit carries `match: corrected` or `match: beginnings`, and the response lists the
   corrections. A human or agent always sees "searched for `retention`, you typed `detention`".
5. Sender/date controls at 1.0; phrase, Boolean, regex, `--exact` and `--newest` unchanged.
6. p95 ≤ 250 ms and ≤ 3× strict on the generated 100k-message archive.

## Recommendation

Take B with one-edit corrections and labelled hits, behind the gates above. Do not put C's partial
fallback in the default: its only gain over B is the any-word hits, which arrive with 80 / 80
no-answer false hits. When B finds nothing, MCP answers name `discover=true` in `next_steps`, and
the CLI says on stderr that `--discover` searches partial matches, so the owner or agent opts in
knowingly. It removes the reason
to use `--language legacy` without moving a single strict result; the ranking gates stay for the
ranking work, where they belong.

## Dependency: plain search covering transcripts, file names and file text

The owner ruled that a plain word searches message text, voice transcripts, file names and file
text. No open PR implements that yet: cm#1010 makes kept transcripts searchable through `content:`
only, and cm#1015 documents `content:` as the way to file text. B depends on it in two ways:

- The vocabulary B corrects against (`words.ts:306`) holds message text only. Once plain search
  covers files, a typo of a word that exists only in file text finds no correction. The whole-word
  check and the correction candidates must read the union of every field plain search covers.
- B decides "strict found nothing" on the plain search. That has to be the new, wider plain search,
  or B will fire on queries whose answer sits in a file.

So B lands after the plain-search-coverage change, or in the same release with the vocabulary union.

## Work items, in order

1. **STANDARD first.** Add the new response labels (`match: corrected | beginnings`, `corrections`)
   and the removal of `--language` to [STANDARD.md](STANDARD.md) in its own PR. Owner approves.
2. **Vocabulary union.** Whole-word check and correction candidates over every field plain search
   covers. Reuse the existing trigram tables; no migration unless the file words lack trigrams
   (then reserve a number in [COORDINATION.md](COORDINATION.md#store-migrations) first).
3. **Narrow step in the service.** After strict returns nothing, for implicit-AND plain words only:
   a whole archive word stays; a known beginning of 3+ letters becomes a prefix; an unknown word
   gets its nearest archive words at one edit. Explicit syntax, phrases, fields, exclusions, AST,
   `--exact`, regex keep strict. Label each hit and list the corrections. Build it as measured:
   rewrite the forgiven words into the resolved query and run strict once more. Reuse
   `searchCombined`'s eligibility (`messages-combined.ts:65-76`) and `correctWords`
   (`correct.ts:55`) with a new edit-limit parameter set to one; do not add a second matcher.
   Running `searchCombined` itself instead measured 2.5× slower with 41 near-word hits.
4. **CLI and MCP default.** `search messages`, `search all` (messages part) and the MCP tool use it.
   `--exact` and MCP `exact=true` turn it off. Parser and registry hints stop pointing at legacy
   (`parser.ts:256`, `registry.ts:424`).
5. **Remove `--language`** in the same release as the default: the option
   (`messages-search-command.ts:74`, `searches-command.ts:46`), the MCP field
   (`src/mcp/tools/search.ts:74`) and the parity catalogue entry together. An empty B answer gets
   the `--discover` pointer: `next_steps` in MCP, one stderr line in the CLI.
6. **SDK transition**, per [combined-search.md](combined-search.md#compatibility-and-release-order)
   steps 3-5: an additive SDK switch first (name chosen in STANDARD), then one breaking release where
   `searchStore` without a language runs strict + narrow instead of legacy. Explicit SDK `legacy`
   keeps the old chain for one documented release. `bot search messages` moves in the same release.
7. **Saved-search replay.** A saved legacy search converts on read through a dedicated conversion
   that keeps bare words eligible for forgiveness, not `migrateLegacyQuery`, which quotes every
   term. Stored records are not rewritten. A saved Lucene search replays with the new default.
8. **Docs.** `docs/search/query-language.md:1-60` and the CLI guides: what is forgiven, how it is
   labelled, `--exact`. Changelog under `Changed — may break callers` for the SDK step.
9. **Release.** cli-messaging first, then tg-cli and max-cli pin the exact version and regenerate
   `docs/commands.md`, per the release order.

## Test plan

- Unit and service tests: strict-answered queries unchanged (same ids, same order); empty strict
  plus typo returns labelled corrected hits; known beginning returns labelled prefix hits; phrase,
  AND/OR/NOT, fields, exclusions, AST, regex, `--exact`, `--newest` unchanged; excluded words
  never corrected; a file-only word is not "corrected" once plain search covers files.
- CLI/MCP contract: stdout JSON carries `match` and `corrections`; the `--discover` hint goes to stderr only.
- Saved replay: legacy records convert with forgiveness; Lucene records replay; nothing rewritten.
- Benchmark: rerun `typo` on dev and report the B gates; fresh held-out families before any
  qualifying held-out claim; 100k-message latency.
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm docs:check`, `pnpm parity:audit`,
  `pnpm standards:check`.

## Owner decisions (2026-10-13)

- Option B, with its own gates (above); the ranking gates stay for later ranking work.
- One edit only.
- B is the default; partial matches stay behind `--discover`, hinted through `next_steps` (MCP)
  and one stderr line (CLI) when B finds nothing. C is not adopted.

## Open questions for the owner

1. "Single words" per word inside a multi-word query (as measured), or literally one-word queries
   only (no measurable gain)?
2. Should a strict saved search that returned nothing start returning labelled forgiven hits on
   replay (proposed: yes)?
