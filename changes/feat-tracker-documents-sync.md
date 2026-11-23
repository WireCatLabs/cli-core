### Added

- **One `sync` for a tracker that holds documents too.** `documentLibrary(options)` answers the shared documents
  commands without their `sync`, and that sync as a step; `addTrackerCommands({ documents: library.sync })` then mounts
  one `sync` that brings the issues and the documents, so linear-cli can mount both and the owner and Desktop keep one
  `<cli> sync`. The answer is the tracker's report with the documents' answer under `documents`; a part that fails is
  named there and in `meta.issues` and the other's answer still shows. `--rescan` lists both again, `--max-pages`
  bounds each part, `--embed` indexes the documents' text, and `--limit` is refused with the reason. A tracker CLI
  without `documents` keeps its `sync` unchanged ([TRACKER.md](../docs/dev/TRACKER.md#one-sync-with-documents)).

### Changed — may break callers

- **`linear` holds documents beside its tracker copy.** Its registry entry is `kind: "tracker"`,
  `kinds: ["tracker", "documents"]`, and a provider that holds `documents` among its kinds is a documents account
  provider, as Drive is. `search all` reads a Linear account once in the tracker lane, under its own key, and once in
  the notes lane, as `notes:<id>`, also when `--source` names `linear` or `linear:<account>`. A caller of `documentAccountProviders()` or
  `isDocumentAccountProvider` now gets `linear` too.
