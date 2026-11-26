### Added

- **`store.mail.catchUp(until?)`** (experimental). Indexes and types every email still waiting for its words, pieces
  or type, a short write at a time, until `until` answers true. `syncMail` calls it once it has saved, so a store
  upgraded to version 76 has its mail typed by its next sync, not by its first search.

### Fixed

- **The first mail search after a large save is fast.** `saveThreads` and `saveThread` now index the words and
  pieces of the mail they save and work out its type and reach inside the same write, plus up to 500 emails and 50
  threads left from before. On 100,000 synthetic emails the first plain search took 87 ms instead of 12.1 s, and the
  first `type:` search on a read-only open 74 ms instead of 2.8 s. A sync slice of 50 threads spends about 14 ms
  more CPU. The word drain that a search or `catchUp` still runs keeps taking batches of 200 in one write for up to
  250 ms, instead of committing every 200 emails. No store version.
- **A mail search on a read-only open no longer fails with "attempt to write a readonly database"** when saved mail
  is still waiting for its words: the drain tried to queue the threads of that mail first.
