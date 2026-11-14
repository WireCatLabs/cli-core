### Changed — may break callers

- **A documents account has no ceiling of 10 000 entries any more** (owner's ruling, 2026-11-14). `catalog.list`
  no longer refuses an account over 10 000 entries or 32 MB of metadata, `catalog.reconcile` takes any number of
  ids, and `documentIngestion`'s catalog import takes any number of files, written 200 at a time. A sync no longer
  reads every document of the account into memory before its first save: each save and removal looks up its one
  document with the new `notes.fileNote(folderId, path)`. One catalog write still takes at most 200 entries and one
  list page at most 1000. Speed and memory at 10 000, 50 000 and 100 000 entries are measured in
  [cli-testing](https://github.com/WireCatLabs/cli-testing/tree/main/performance/documents/catalog-scale).
  A store that implements `NotesStore` itself must add `fileNote`; a caller that relied on the
  `catalog.scope-limit` error no longer gets it.
