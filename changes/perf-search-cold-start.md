### Fixed

- **A meaning search over all chats no longer reads every vector of the store.** The vector index rarely held the
  exact answer among its most candidates across all chats, and the search then fell back to a scan of every vector:
  15 seconds and more when the store was not in memory. Across all chats it now keeps what the index's 4,096 nearest
  chunks hold.
- **The owner's block finds the owner's chunks through the owner's own messages.** Without planner statistics SQLite
  walked every message of the account to find them: 17 seconds from a cold disk on a store of a million messages,
  0.35 seconds now.

### Added

- `WIRECAT_SQL_SLOW_MS=<ms>` prints each store statement slower than that to stderr, with its time, rows and shape.
