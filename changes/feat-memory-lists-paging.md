### Added

- **`memories.list`, `facts.list`, `proposedActions.list` and `agentActions.list` take an `offset`.** A caller pages
  past the 500-row cap: `{ limit: 500, offset: 500 }` gives the next 500 in the same order, newest first with ties by
  id, so no row shows twice and none is left out. memo's `--page` reads through it, so WireCat Desktop can show more
  than 500 memories, facts or actions.
