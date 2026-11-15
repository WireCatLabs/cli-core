### Added

- **`syncDocuments` takes a `budget`** (a `RunBudget`), asked before each folder listing and each file read: a stop
  ends the call with its work saved. The shared `sync` command passes `runBudgetOf(command)` as `budget` in its
  arguments, for the CLI to hand on. See [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
- **`SourceIndex.settle` and `store.notes.indexWritten`.** At the end of a sync the engine indexes the store's waiting
  text for word search, so a read-only reader finds a page by the words of its text right after the sync; before, the
  text waited until a writable store ran a search. The queue is shared by every tool on the store. It works 50 rows at
  a time and yields between them, and stops after 10 s, at `deadline` less its margin, or on the signal; it is skipped
  after a budget stop. `documentIngestion` supplies `settle`; `indexWritten` answers 0 on a read-only store.
- **`SyncOptions.deadline` and `DocumentSyncArgs.deadline`:** the run's hard limit, which the shared `sync` command
  passes for the CLI to hand on.
- **`documentSourceContract` checks a deep change** when the fixture gives `addNested`: the feed must name a file
  added two levels below the root, or its own folder.
- **The catalog's `parent` filter takes several ids** (`parent: [a, b]`), read in one pass of the account's catalog.
  `catalog tree` asks about the branches it cuts this way: 1 000 branches in a 12 000-entry account take about
  0.06 s instead of 3.2 s ([measured](https://github.com/WireCatLabs/cli-testing/blob/main/performance/documents/sync-scale/README.md)). `documentIngestion`'s `catalog.get` and `catalog.list` take an id with or without `.md`.

### Changed — may break callers

- **A sync no longer fails for the size of the chosen folders.** `maxEntries` now bounds one call: a walk past it
  saves where it stopped, answers `complete: false`, `stopped: "entries"` and `walk: { folders_left, entries,
  listed }`, and the next sync goes on from there. `limitError` is no longer called. `SyncResult` gains `complete`,
  `stopped` and `walk`. The shared `sync` command declares `partial`: an unfinished pass (a walk or pending
  operations) answers `meta.complete: false`, exits 0 and names the same `sync --limit` as its next step
  (`sync.run`, safe to run unasked). Its help no longer says one sync reads at most that many entries.
- **A changed folder lists only its direct children.** A round of changes no longer walks the whole subtree of each
  folder the feed names: a child folder the last finished pass held is not listed again. An edit to a page with 500
  pages below it, and to one of them, lists those 2 pages instead of 501. A source must therefore name in its feed
  each changed entry or its own folder: one that names only an ancestor misses a file two levels below until a
  rescan. A folder new to the scope
  (new, restored, or moved in from outside) is still walked in full, so the files under a Drive folder moved in are
  found. A round a call cuts short is saved and goes on in the next sync.
- **`--rescan` goes on until it finishes.** It drops the cursor and any saved walk and saves that at once, so the
  following plain syncs continue its walk. A dropped batch's work saved to the index without the state knowing is
  removed when the batch is dropped, no longer counted in `removed`, and the state is saved right after.
- **A folder deleted or unshared since the walk saved it is dropped**, with what was below it, when listing it answers
  `not_found`; before, a saved walk would have failed on it in every later sync.
- **A test that expects the sync to fail for size now fails.** drive's
  `says to choose smaller folders when the chosen ones hold more entries than one sync reads` (`src/sync.test.ts`)
  expects that error; on its bump it should expect `complete: false` instead. drive's own bound on one folder
  listing or one change feed (10 000 entries, in `google.ts`) is unchanged.
- **The saved walk keeps only `SourceWalk`'s fields.** drive's saved `walk.json` and `state.json` keep working as
  they are; a round of changes is saved under the scope `<scope>:changes:<cursor>`.
