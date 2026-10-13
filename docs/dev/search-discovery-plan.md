# Search discovery integration

The implementation is released in `@wirecat/cli-core` 0.216.0, adopted by Telegram 0.44.0
and MAX 0.43.0. CLI `--discover`, MCP `discover: true` and SDK `SearchQuery.discover` share the
archive service. Saved searches preserve the option. Strict Lucene and existing SDK compatibility
remain the defaults; the original default-switch gates are still unmet.

Discovery retrieves partial lexical matches through SQLite FTS, combines lexical ranks with word
coverage, and adds eligible direct replies. It uses neither neural downloads nor a full in-memory
archive snapshot. Migration 29 supplies a derived reply lookup index. Account, chat, sender, date
and `only` restrictions apply to both parent and child. Explicit Boolean syntax, phrases, wildcard,
AST, exact and newest requests retain strict behavior. Metadata exposes candidate bounds, matched
and missing terms, actual queries and parent provenance; a score is not an answer probability.

Evidence and resources live in [cli-testing performance/search](https://github.com/WireCatLabs/cli-testing/blob/63de1d7870e5d983bbc05dd253cdb66d0bbfd7cd/performance/search/model-free/FRESH-VALIDATION.md).
Fresh wording exposed candidate gaps in the frozen snapshot prototype: 9/16 actual answers in the
top ten. Storage-backed partial retrieval reaches 16/16, 14/16 in the top three and 2/16 first.
These questions became development examples, not a blinded quality certificate. Historical
controls keep paraphrase and missing-fact failures. Whole-process query resources are separated
from ingestion; no neural assets are needed.

Required shared and consumer checks pass. Released npm binaries were exercised with synthetic
messages and isolated state, with network and keyring access blocked: the eligible reply is found,
the other sender is excluded, and ordinary strict search stays empty for the same question.
No real account, messenger action or owner store was part of the verification.

The owner authorized continued improvement, merges and dependency/CLI publication without repeat
permission questions. Private release records describe this delegated authorization accurately;
they do not claim a personal owner review or a live check that did not happen.
