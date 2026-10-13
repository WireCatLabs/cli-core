# One message search: measured design

The implemented integration is an additive `--discover` / MCP `discover=true` / SDK
`SearchQuery.discover` archive option, described in [the handoff](combined-search-handoff.md).
The single-default replacement proposed below remains unqualified by its approved gates.
Strict CLI/MCP behavior and no-language SDK compatibility are preserved. The explicit option
returns partial lexical evidence with visible missing terms and bounded context; it does not
establish answer confidence or qualify a default switch.


Status: the owner approved the lexical and semantic experiments. Lexical reranking and e5 cosine
ranking fail the dev quality gates; joint query-message ranking improves the measured results.
CLI/MCP and SDK defaults remain unchanged while latency and the original held-out quality gates
remain unmet. Natural-language question retrieval is a separate diagnostic, not a public feature.

The [evaluation notes](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/combined-search-evaluation.md) record the contribution of each experiment,
the retrieval/scoring pipeline, metric interpretation and proposed next measurements.

## Evidence and acceptance targets

The [message benchmark](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/message-search/README.md) uses 2,616 synthetic messages,
96 queries, ready word/stem indexes, a temporary store and the current production `searchStore`.
Its [raw baseline](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/message-search/baseline.json) contains every query in both modes.
Four topic families per split give 40 answerable and eight no-answer queries each; there is no
real account, model download or network use. Reproduce with the benchmark README's three commands.

| Split | Search | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits |
|---|---|---|---|---|---|
| dev | strict Lucene | 0.313 | 0.325 | 0.287 | 0 |
| dev | legacy chain | 0.388 | 0.425 | 0.354 | 80 |
| held-out | strict Lucene | 0.263 | 0.325 | 0.219 | 0 |
| held-out | legacy chain | 0.338 | 0.450 | 0.299 | 80 |

Strict search has zero recall on typos and unfinished words in both splits. Legacy's corresponding
held-out recall is only 0.125: it retrieves keyword-heavy distractors ahead of useful messages.
Its broad fallback also returns ten hits on every no-answer request. Sender/date controls reach
full recall; unfiltered keyword/phrase/chat/Boolean categories remain poor. Inspect category and
per-query results alongside aggregates. These invented templates do not establish real-world quality.

Proposed release gates, fixed before implementation:

- Dev and held-out recall@10 at least 0.45, MRR@10 at least 0.50, nDCG@10 at least 0.40. All three
  must also beat both baseline modes on their respective split.
- Zero no-answer false hits in each split, preserving the stronger strict baseline.
- Sender/date control recall remains 1.0; phrase and explicit Boolean eligibility stay identical
  to the strict baseline. In those categories ranking may improve but cannot broaden eligibility.
- Typo and beginnings recall improve above each split's legacy baseline. Report paraphrase misses
  separately; semantic retrieval is not a requirement of the lexical release.
- No scope leaks, duplicated locators or unlabelled combined hits. No change to regex eligibility
  or `--newest` chronological ordering. Strict results with the same execution AST remain identical.

These are acceptance targets, not measured promises. If lexical ranking cannot reach them, bring
back the measured limitation and a revised plan for approval. Do not tune on held-out failures or
weaken labels. Freeze the dev-selected configuration before evaluating held-out; a second development
cycle needs a fresh held-out set. Baseline exposure means this holdout is not blinded.

## Measured lexical experiment and revised proposal

The internal [matcher](../../src/services/messages-combined.ts) evaluates word/stem, prefix and
corrected candidates independently, retains resolved hard predicates, fuses by rank position and
can rerank using term strength/coverage, minimum token span and phrase adjacency. It bounds depth,
AST nodes, hydrated body bytes, reranking work and elapsed time; all candidate paths check account
scope and cancellation. It is not wired to public services, CLI, MCP, bots or saved replay.

[The dev sweep](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/message-search/combined-dev.json) varies all 180 combinations:
depth 50/100/300/500, RRF k 20/60/100, no reranker/coverage/proximity/phrase/all, and chat caps 0/3/5.
Every combination produces the same dev relevance metrics:

| Mode | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits |
|---|---|---|---|---|
| Strict baseline | 0.313 | 0.325 | 0.287 | 0 |
| Legacy baseline | 0.388 | 0.425 | 0.354 | 80 |
| Combined lexical | 0.363 | 0.375 | 0.326 | 0 |
| Approved minimum | 0.450 | 0.500 | 0.400 | 0 |

Typos and beginnings reach recall 0.250 on dev, improving on strict's zero but merely matching
legacy. Sender/date controls retain full recall. Explicit AND/OR and phrases preserve strict
results and order. The lost legacy paraphrase hits came from broad any-word retrieval; removing
that noise also removes occasional useful hits. No setting clears the gates or beats legacy's
answerable metrics. Candidate depth and chat diversification do not distinguish useful messages
from newer templates with the same words and adjacency. This is a result for these tested signals
and corpus, not proof that every lexical ranking method is inadequate.

No held-out evaluation was run for combined search because no dev configuration qualified.
No 100k-message latency claim is made; release-scale performance work follows a qualified design.
The old baseline remains committed unchanged. The smallest experimental configuration is reported
for inspection, not selected as a release recommendation; the internal defaults are provisional.

The approved semantic experiment measures a local reranker over bounded, filter-valid lexical
candidates before changing the public default. Model preparation is an explicit separate step;
the benchmark itself cannot download a model, connect to a messenger or open the real store.
Evaluate per-message text against the whole query; compare it with chunk-to-message semantic
retrieval only if lexical candidate recall itself is inadequate. Do not reuse the conversation
0.80 cosine floor as a message threshold.

Keep these relevance labels and release gates. Add separately authored question-form dev queries
that explicitly ask for the decision/policy when that is the intent; do not substitute them for
this keyword-query benchmark or relabel distractors. The existing `intent` field contains the
answer text and must never be passed to retrieval or a reranker. Create fresh held-out topic/query
families before tuning the new approach, freeze the dev choice, then evaluate held-out once.
If semantic ranking also fails, report that result rather than relax the release gates implicitly.
All CLI/MCP removal, SDK/saved conversion and consumer releases below remain pending the full
quality, latency and query-contract checks.

## Semantic experiment

The [semantic benchmark](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/message-search/README.md#candidate-recall-and-semantic-ranking)
preserves the original corpus/labels and adds separately authored question queries plus fresh
held-out families. Candidate recall reaches 0.90 at depth 300: every non-paraphrase category has
full candidate recall, while paraphrase requests have none. Most misses in the top ten are ranking
errors, not absent candidates. No broader semantic retrieval has been introduced.

The installed pinned e5-small embedding model reduces dev keyword recall@10 to 0.275 and fails
the quality gates. Clearer questions help it rank some answers, but cosine floors cannot retain
answers while eliminating the new no-answer hits. Reject embedding cosine as this message reranker.

The benchmark then evaluates an official Apache-2.0 quantized
[query-message model](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1), pinned separately
in [reranker.json](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/message-search/reranker.json). It scores query and message
together rather than comparing separately generated vectors. The benchmark uses its raw identity
logits, with no automatic model installation, and freezes the dev-selected configuration before
held-out inference. This is a benchmark adapter, not a public model catalogue or service addition.

Question reranking uses explicitly authored topic anchors for candidate retrieval. Sending a full
question directly to the current implicit-conjunction Lucene search returns no candidates. Thus
successful question reranking is diagnostic evidence, not a completed natural-language search path.
The unknown-auditor queries test whether a model can reject a topical message that lacks the
requested fact. The original keyword/no-answer queries remain unchanged and are reported separately.

The joint reranker improves original dev keyword recall/MRR/nDCG to 0.525/0.553/0.477, with zero
no-answer hits. The frozen original held-out result is 0.438/0.488/0.405, also with zero false hits:
it beats strict and legacy on all three quality measures but misses the 0.45 recall and 0.50 MRR
gates. Do not retune on these held-out results. The same-archive strict/legacy baseline confirms
that supplemental messages do not account for the improvement. The fresh question diagnostic
reaches 0.688 recall, MRR 1.0 and nDCG 0.866, with zero no-answer hits, under manual topic anchors.
Raw results and reproducibility instructions are in the benchmark README. These are small,
synthetic evaluations with shared templates, not evidence of general real-archive performance.

The measured CPU pair cost is roughly 10–12 ms per message; scoring 300 fresh candidates takes seconds
and misses the proposed 250 ms latency gate. A model load also costs roughly one second. Synthetic
exact-pair caches do not establish production warm latency for a different query. Public adoption
needs the original held-out quality gates and a measured cost reduction, or an explicitly revised
release policy. Natural-language question support additionally needs automatic candidate selection;
the existing public contract remains Lucene expressions. Ranking gains alone do not qualify a release.

## Query behavior

CLI and MCP accept one language, Lucene, and remove the `--language` option. Parse and resolve once
through the existing parser/registry and `prepareLucene`. Keep account authority, field validation,
timezone handling, coverage, context, thread hydration, cancellation and query budgets.

Forgiving matching applies to bare positive `text` words in an implicit-conjunction query. Exact
field predicates, exclusions, phrases, wildcard/regex predicates and non-text filters remain hard
constraints in every candidate path. Queries containing explicit AND, OR, NOT, required/prohibited
operators, or an externally supplied AST use the strict path for the first release. Preserve lexical
intent from source tokens: the current AST does not distinguish implicit from explicit conjunction,
so inspecting the AST alone is insufficient. Mixed ordinary words plus phrases/filters may expand
only those ordinary words, with all other predicates checked on every candidate. Excluded words
are never corrected or relaxed. Empty/filter-only requests keep their existing order and carry
`match: filters`; do not invent relevance for a request with no text.

Example: `aurora rolluot chat:101` can find `rollout` and reports the correction, while
`aurora AND rolluot`, `exact:rolluot`, and `"aurora rolluot"` remain literal. A correction is evidence
of a possible spelling, not permission to remove another requested word or filter.

`--exact` disables every forgiving candidate path. Preserve its existing default-field mapping to
`exact`, including disabling stemming on bare words/quotes. This is stricter than today's default
Lucene `text` field, which includes stems. Callers needing today's stemmed strict behavior can use
explicit `text:` predicates or an AST; the plan does not silently redefine the existing exact flag.
Document this distinction in CLI/MCP discovery and migration examples.

Keep `--regex` as the explicit JavaScript regex operation, using the internal regex implementation
and its existing account restrictions. It does not require a selectable legacy query language.
Keep the legacy chain internally during compatibility work; bot message search moves onto the
combined path only after its account restrictions and default-request tests pass.

## Candidates, fusion and ranking

Run eligible matchers independently so an exact hit cannot suppress useful corrected/prefix hits.
Reuse indexed word, stem, prefix and correction primitives; do not translate arbitrary Lucene ASTs
into legacy WordQuery, which would lose Boolean and field semantics. Build bounded transformed
executions from the resolved query and validate every hard predicate in the same authority scope.
No table or migration is proposed for the lexical release.

Candidate sources are exact words, stems, word beginnings and corrected whole words/beginnings.
Correct only unknown ordinary words with the existing edit-distance/trigram vocabulary rules.
Each source retains its own rank position; raw word BM25, stem BM25 and timestamp ranks are not
numerically comparable. Collapse duplicates by full message locator, including provider/account.
Exact/stem lists share one words contribution per locator so correlated lists cannot double-vote;
corrected whole/prefix lists similarly share one corrected contribution. Prefix adds a contribution
only when it actually expands a term, avoiding repeated votes for the same exact match.

Fuse independent lists with reciprocal rank fusion. Start with k=60 as notes/conversations do;
compare k in {20, 60, 100} and per-source candidate depth in {50, 100, 300, 500} on dev only.
The corpus intentionally has 300 distractors per topic, so depth 50 must not be assumed sufficient.
Choose the smallest configuration meeting the dev gates; break ties by higher nDCG, then lower
measured latency. Cache correction vocabulary reads once per query; concurrent promises do not
make a synchronous SQLite driver compute in parallel.

Rerank the bounded union against the complete query. Evaluate term coverage, literal-vs-stem-vs-
correction strength, minimum token span, phrase adjacency and normalized RRF; compare each signal
by dev ablation instead of committing unmeasured weights. Never treat recency as answer quality.
Use deterministic ties: fused rank, timestamp, then full locator. Simple lexical signals cannot
reliably distinguish a decision from an unanswered question with identical words; the benchmark
includes that limitation deliberately. Do not add corpus-specific answer words or project names.

Compare no diversity cap with a soft cap of three or five hits per chat in the first ten results.
Apply it after reranking, backfilling deferred hits if no other chats qualify; disable it when the
request scopes to one chat. Expand it proportionally on larger pages and evaluate pagination so
hits cannot be silently lost. A conversation cap requires conversation membership and extra work;
defer it with the meaning phase. Adopt the cap only if dev improves without reducing control recall.

Drop automatic any-word and raw-substring candidates from the combined lexical default. The legacy
benchmark's no-answer noise makes their inclusion unjustified. Existing explicit Lucene wildcard,
regex and OR expressions provide deliberate broader retrieval. The SDK compatibility chain keeps
its old weak steps until the breaking transition; the new default does not pad empty results.

Every combined hit carries the strongest `match` label (`words`, `beginnings`, `corrected`, or
`filters`), a `matches` list of all contributing labels, and a finite positive `score`. Stems use
`words` and existing query stemming metadata. Scores express ordering within this query, not a
probability or a cross-query confidence threshold. Return only corrections that contributed an
eligible hit. Preserve readiness/coverage even on empty results. If the word index is not ready,
use the current Lucene readiness error, rather than fall back to an unlabelled substring result.
Strict/regex paths keep their current result shapes unless an additive label is needed for consumers.

Candidate truncation must be visible in query metadata (`candidateDepth`, `truncated`) and
`hasMore`; a bounded shortlist is not proof the archive has no more matches. Define deterministic
paging over that shortlist before enabling it in `search all`, saved replay and MCP. Test limits
1/10/50/1000 and `--newest`; chronological requests sort eligible combined candidates by timestamp
and report truncation rather than claim to have scanned the full archive. Measure warmed query
p50/p95 on this corpus and a generated 100k-message isolated archive. Proposed latency gate:
p95 <= 250 ms and <= 3x strict for ordinary lexical queries; retain existing execution budgets.

## Meaning phase

Do not ship meaning in the first release. Conversation-chunk vectors do not supply independent
message ranks, and the conversation e5-small floor of 0.80 is not a validated message threshold.
A later measured proposal must map candidate chunks only to their member messages, rerank each
message against the query, bound contributions per chunk/conversation, enforce every hard filter,
and preserve lexical-only behavior when the local model/index is unavailable. It must never
install a model or embed the archive as a search side effect. Add a `meaning` label through an
explicit type/discovery update and choose its threshold on a separate dev set with no-answer
controls. Record mapping, freshness, coverage and latency, then seek approval for that release.

## Compatibility and release order

This proposal includes the separately agreed breaking window required by the
[stable-export policy](../../README.md#how-often-and-what-may-break).

1. Build behind an internal entry point after approval. Keep default `MessagesService.search` and
   `searchStore` legacy semantics, and explicit language requests, until the coordinated breaking
   release. Test old SDK requests against the unchanged chain. Add new combined tests and benchmark
   measurement without replacing the committed baseline.
2. Adapt saved replay before switching the default. Keep stored legacy originals and convert on
   read into a versioned Lucene execution with preserved filters/exclusions and bare positive words
   eligible for forgiveness. The current `migrateLegacyQuery` quotes every term and adds explicit
   AND; reusing it unchanged would disable the intended expansion. Extend a dedicated conversion
   with provenance and warnings; evaluate rolling relative-date filters at replay time, preserving their
   original moving window, and report UTC normalization when the original timezone is unavailable.
   Store regex records as regex. No destructive rewrite of saved searches or history. A changed
   replay keeps `migratedFrom: legacy` metadata; newly saved records use Lucene. Any conversion that
   cannot preserve hard eligibility fails with the saved id and an actionable preview.
3. In one cli-core breaking release, switch no-language SDK requests to combined Lucene,
   remove CLI/MCP language selection, and retain the deprecated SDK language field for one documented
   transition release. Explicit SDK `language: lucene` keeps strict semantics during that transition;
   `language: legacy` continues the old chain. A later breaking release can remove that field.
   Old SDK users preserve discovery temporarily with explicit legacy or migrate to combined;
   scripts use `--exact` or explicit `text:`/AST for strict stemmed matching.
4. Update parser error alternatives, registry-generated tables/recipes, query specification, search
   schemas, rendering, `search all` scoring, bot paths, saved replay, command reference and skills.
   Remove language selection from the parity option catalogue and regenerate command discovery,
   shell completion and reference tables together; account permission flags stay unchanged.
   Put user-visible changes and migration instructions under `Changed — may break callers`.
   Run `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm docs:check`, the benchmark's own
   TypeScript check, dev ablations and the frozen held-out evaluation. Record the quality/latency
   report and exact production hashes. Never touch the real store or `src/replies/**`.
5. Release cli-core first, then create draft PRs in tg-cli and max-cli pinning its exact published
   version, updating generated `docs/commands.md`, skills and breaking changelog entries. Avoid other
   consumer `docs/*.md` prose owned by `docs/reader-standards`. Verify unreleased builds with
   `bin/try-messaging` in consumer worktrees; no committed `file:` dependency. Arrange same-day
   consumer moves when the breaking shared release lands. The breaking default switch does not proceed while its quality gates are unmet.

No migration number is needed now. If saved conversion or later semantic work requires schema
changes, reserve a number first through [coordination](COORDINATION.md#store-migrations).
Approval covers the lexical design, quality gates, deferred meaning phase and coordinated SDK
transition. Any failure to meet those gates returns to a measured proposal before release.
