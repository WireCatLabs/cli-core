### Fixed

- **The install is 28 MB smaller: the Anthropic adapter calls the API over plain `fetch`, without
  `@anthropic-ai/sdk`.** The packed cli-core installs in 253 MB on disk instead of 281 MB, with 8 packages fewer. The
  adapter sends the same streamed `POST /v1/messages` as before, with the same key header, API version 2026-10-21,
  no retries and the same answers, errors and token counts.
