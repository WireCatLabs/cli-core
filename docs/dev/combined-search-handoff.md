# Message search handoff

Message search has a released additive archive discovery path in
`src/services/messages-discovery.ts`, shared by CLI `--discover`, MCP `discover=true` and SDK
`SearchQuery.discover`. It uses bounded partial lexical matching and eligible direct replies,
without neural downloads or a full archive snapshot. Ordinary word discovery also reuses the
combined word, prefix and correction candidates in `messages-combined.ts`.

CLI/MCP strict Lucene defaults and no-language SDK compatibility remain unchanged. The earlier
single-default replacement did not pass its approved quality gates; those gates still apply to
any default switch. The explicit discovery option surfaces partial-match evidence, missing terms
and parent provenance rather than claiming to determine whether an answer exists.

All experiments live in
[cli-testing performance/search](https://github.com/WireCatLabs/cli-testing/blob/63de1d7870e5d983bbc05dd253cdb66d0bbfd7cd/performance/search/README.md).
Historical reports and model comparisons remain there. Fresh authored wording reduced the frozen
model-free prototype to 9/16 actual answers in the top ten, exposing retrieval failures. Bounded
partial retrieval recovers the missing evidence, while answer ranking remains a measured limit.
The fresh examples are synthetic and authored during this investigation, not independently labeled
real-world judgments.

Implementation safeguards:

- Both parent and reply satisfy account, chat, sender, date and `only` filters; explicit syntax,
  AST, exact and newest requests retain strict behavior.
- Retrieval and final scoring retain at most 300 candidates, with at most 100 proposed direct
  replies, bounded text and the existing execution deadlines. Truncation remains visible.
- Migration 29 adds a live direct-reply index after
  [reservation PR 817](https://github.com/WireCatLabs/cli-core/pull/817).
  The `only` predicate looks up named message keys rather than scanning every archive row.
- Discovery searches the archive. It does not call a messenger server, install a model or rebuild
  conversations as a query side effect. Surrounding context and requested thread packets remain
  available through their existing paths.

Delivery is complete: `@wirecat/cli-core` 0.216.0, `@wirecat/tg-cli` 0.44.0 and
`@wirecat/max-cli` 0.43.0 are published. Both consumers pin the exact shared release; their npm
binaries retrieve eligible synthetic replies with network/keyring access blocked. The installed
commands report these versions. Shared and consumer checks, coverage, documentation and
platform/install CI pass.

The fresh development fixture finds an actual answer for 16/16 questions in the top ten, 14/16
in the top three and 2/16 at rank one. At 100,341 synthetic stored messages, query p95 is about
108 ms and peak query-process RSS about 124.5 MB on the measured laptop. These are whole query
process resources, without model weights; ingestion is measured separately. Original controls
retain eight top-ten paraphrase failures and 160 partial hits on missing-fact queries. Discovery
is not an answer-availability detector. No real store or `src/replies/**` is part of this
work. See [the integration notes](search-discovery-plan.md) for the current delivery sequence and
[the original default-switch proposal](combined-search.md) for its unfulfilled qualification gates.
