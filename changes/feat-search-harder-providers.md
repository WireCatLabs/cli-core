### Added

- **`models search-consents set` takes `openai`, `anthropic` or an OpenAI-compatible API (`--base-url`, such as
  OpenRouter).** Each provider has its own default model for `search all --harder` (`claude-haiku-5-5`,
  `gpt-4o-mini`); another API needs `--model`. `show` proposes enrichment's provider and model when the owner chose
  one there, but never gives this consent by itself. The answer's `harder` field names the `endpoint` too. Anthropic's
  `thinking` and `output_config` go to Anthropic only; OpenAI gets its JSON mode, and any reply wrapped in a code block
  is still read. See
  [AI providers, "Search harder"](../docs/search/ai-providers.md#search-harder-a-hosted-model-reorders-search-all-off-by-default).

### Fixed

- **`search all --harder` sends the question as typed.** It sent the query parser's escaped copy (`deposit\?`), and a
  `$&` in a question was read as a replacement pattern.
