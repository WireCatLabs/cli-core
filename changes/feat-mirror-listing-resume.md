### Added

- **A file mirror's remote listing goes on across runs**, so a cloud disk too big to list in one run (100,000 files
  at about 30 s a page) syncs fully over several. `FileTarget.list` takes an optional `from` and may return `next`
  for an incomplete listing; the engine keeps the files so far and `next` in the mirror's state (`listing`), merges
  the next run's files by path and by id, and proves deletions only once the listing completes, each still by a
  direct `exists` read. A saved listing over 7 days old, of another root folder, or past 100,000 files starts over;
  a dry run saves none. A target without `next` lists from the start each run, as before
  ([DOCUMENTS.md, point 12](../docs/dev/DOCUMENTS.md#sync-plain-files-with-a-provider)).
