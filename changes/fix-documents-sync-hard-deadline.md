### Added

- **`embedNotes`, `embedEvents` and `embedMail` take `deadline` and `signal`.** They stop between batches at the
  deadline less its margin, or on a cancel, and answer `stopped` and, for notes and events, `remaining`: the chunks
  still without a vector. Enrichment before the embed gets the same limit. Calendar `sync --embed` passes its run's
  deadline and signal, so a sync that ends late no longer runs into `command.timed-out` while it embeds. See
  [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
- **`RunBudget.first()`**: whether a call's first request goes past a `deadline` stop.

### Fixed

- **A documents sync no longer overruns its deadline after a slow first listing.** The first-request exception held
  for the walk's first listing and again for the first file read, so a 4 s run could list for 1.9 s, read for 3 s
  and end at 4.9 s. Now only one request per call goes past the margin, only before any other, sized by the CLI's
  `requestMs` plus 0.5 s to answer, and timed by the budget's clock rather than a sync's fixed `now`.
