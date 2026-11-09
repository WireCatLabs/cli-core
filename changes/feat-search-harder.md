### Added

- **`searchAll` takes `harder`: a hosted model reorders the first 30 hits (off by default).** Claude Haiku reads the
  question with the hits and puts the ones that answer it first; in the search lab, over a first stage with Haiku
  rewrites, it lifted LifeBench recall@10 from 0.49 to 0.55 for about $0.0004 a question. It sends only when a search asks, the owner has agreed with
  `models search-consents set anthropic --yes` (memo), and a key is found. Any failure or a 5 s wait keeps the plain
  order, and the answer's `harder` field says why. See
  [AI providers, "Search harder"](../docs/search/ai-providers.md#search-harder-a-hosted-model-reorders-search-all-off-by-default).
- **The Anthropic model adapter takes `thinking` and `output_config` (effort, JSON schema format).**
