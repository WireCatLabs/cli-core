### Added

- **`harderRanking(result)` gives the `--harder` outcome as cli-base 0.94.0's `meta.ranking`.** A CLI that offers
  `search all --harder` puts it into its answer's `meta`, so a program such as WireCat Desktop reads whether the
  model's order was used, why not (`reason_id`), which provider, model and endpoint, how many hits were sent, the cost
  and, new in the result, the tokens (`usage`) instead of an English note. cli-base goes to 0.94.0.

### Changed — may break callers

- **The MCP `<app>_read` and `<app>_write` tools list a short answer schema: 3,323 characters for the three tools in
  place of 17,278.** It names only what an agent acts on: `items` or `item`, `page.has_more`, `next`, `missing`, and
  `meta` as an open object that points at `<app>_tools_search`, whose match still gives each command's full answer.
  `_write` lists only `item`, `next` and `meta`, all a write answers with. The server still checks every answer
  against the full cli-base envelope, so nothing an answer carries changes. Every client paid the full schema twice
  on each connect, and cli-base 0.94.0's `meta.ranking` added 2,800 characters more. Watch for: a
  client that built types from the listed `outputSchema` now gets open objects; it reads the full answer from
  `<app>_tools_search`. An agent eval found no loss: 39 of 42 tasks with either listing, on half the input tokens
  ([cli-testing](https://github.com/WireCatLabs/cli-testing/tree/main/performance/agents/mcp-short-listing)).

### Fixed

- **`doctor --online` asks npm through `hostFetch`**, which reaches only `registry.npmjs.org`. cli-base 0.94.0's
  `raw-network` lint reported the global `fetch` it fell back to. The model gateway and OpenAI transcription keep the
  global `fetch` in the lint baseline: they call an endpoint the owner configures (OpenRouter, a local server), so no
  host list can be declared in advance.
