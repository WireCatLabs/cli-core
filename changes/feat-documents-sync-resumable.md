### Added

- **`syncDocuments` takes a `budget`** (a `RunBudget`), asked before each folder listing and each file read: a stop
  ends the call with its work saved. The shared `sync` command passes `runBudgetOf(command)` as `budget` in its
  arguments, for the CLI to hand on. See [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
- **`SourceIndex.settle` and `store.notes.indexWritten`.** At the end of a sync the engine indexes what it saved for
  word search, for at most 10 s, so a read-only reader finds a page by the words of its text right after the sync.
  `documentIngestion` supplies `settle`; before, the text waited in the queue until a writable store ran a search.
- **The catalog's `parent` filter takes several ids** (`parent: [a, b]`), read in one pass of the account's catalog.
  `catalog tree` asks about the branches it cuts this way: 1 000 branches in a 12 000-entry account take about
  0.05 s instead of 3.1 s ([measured](https://github.com/WireCatLabs/cli-testing/blob/main/performance/documents/sync-scale/README.md)). `documentIngestion`'s `catalog.get` and `catalog.list` take an id with or without `.md`.

### Changed — may break callers

- **A sync no longer fails for the size of the chosen folders.** `maxEntries` now bounds one call: a walk past it
  saves where it stopped, answers `complete: false`, `stopped: "entries"` and `walk: { folders_left, entries,
  listed }`, and the next sync goes on from there. `limitError` is no longer called. `SyncResult` gains `complete`,
  `stopped` and `walk`. The shared `sync` command declares `partial`: an unfinished pass (a walk or pending
  operations) answers `meta.complete: false`, exits 0 and names the same `sync --limit` as its next step
  (`sync.run`, safe to run unasked). Its help no longer says one sync reads at most that many entries.
- **A changed folder lists only its direct children.** A round of changes no longer walks the whole subtree of each
  folder the feed names: a child folder the last finished pass held is not listed again. An edit to a page with 500
  pages below it, and to one of them, lists those 2 pages instead of 501. A folder new to the scope
  (new, restored, or moved in from outside) is still walked in full, so the files under a Drive folder moved in are
  found. A round a call cuts short is saved and goes on in the next sync.
- **`--rescan` goes on until it finishes.** It saves the dropped cursor at once, so the following plain syncs continue
  its walk, and a `--rescan` while a full pass is under way continues it rather than starting again. A dropped batch's
  work saved to the index without the state knowing is removed when the batch is dropped, and no longer counted in
  `removed`.
- **A test that expects the sync to fail for size now fails.** drive's
  `says to choose smaller folders when the chosen ones hold more entries than one sync reads` (`src/sync.test.ts`)
  expects that error; on its bump it should expect `complete: false` instead. drive's own bound on one folder
  listing or one change feed (10 000 entries, in `google.ts`) is unchanged.
- **The saved walk keeps only `SourceWalk`'s fields.** drive's saved `walk.json` and `state.json` keep working as
  they are; a round of changes is saved under the scope `<scope>:changes:<cursor>`.
