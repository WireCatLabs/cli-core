### Added

- **`store.tracker.save` and `removeUnlisted` take sync state to save in the same transaction**: `save(key, kind,
  records, now, state?)` and `removeUnlisted(..., { state })`, as `mail.saveThreads` takes its states. `syncTracker`
  saves a page's cursor this way, so a wrapper around `store.tracker` must pass `state` on. A dry run of
  `removeUnlisted` now only reads
  ([TRACKER.md](../docs/dev/TRACKER.md#synctrackersource-store-account-options)).

### Fixed

- **A tracker sync commits half as often** (#3336). Each page of changes is saved with the cursor after it in one
  transaction, the end of an id pass with its marks, and the end of the run in one more. Each commit waits for the
  disk: the strict fake's 8 kinds of 3 rows went from 79 commits to 38 (median 354 → 214 ms on a busy disk), 2,000
  issues from 101 to 53
  ([sync-writes](https://github.com/WireCatLabs/cli-testing/tree/main/performance/tracker/sync-writes)). What is
  stored is the same. A page is now saved with its cursor or not at all; before, a crash between the two read the
  page again.
