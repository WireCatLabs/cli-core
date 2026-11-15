### Changed — may break callers

- **The shared documents `sync` is cooperative.** It declared `partial` but not `cooperative`, so it got a one-shot's
  30 s deadline and a budget of about 12 requests per call: a first Notion sync of 5 000 pages took some 830 calls.
  It now gets a sync's deadline, 15 min in a terminal and 45 s over MCP, unless `--timeout` sets one. A cancel no
  longer cuts the command from outside: the walk stops at the next folder on the run's `signal` (with or without a
  budget) and saves where it is, and the batch stops before the next file, as before. See
  [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
