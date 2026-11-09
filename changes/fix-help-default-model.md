### Fixed

- **Help and docs name EmbeddingGemma as the default text model.** `conversations embed --model` said
  "default: e5-small" and now reads the name from `DEFAULT_TEXT_MODEL`. The option table in `STANDARD.md` no longer
  describes `--accept-terms` as accepting the licence terms: it is ignored. `docs/search/ai-providers.md` no longer
  says e5-small is the default. e5-small stays a choice and the fallback on a machine that has only it.
