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
  provider, as Drive is: `documentAccountProviders()` and `isDocumentAccountProvider` now answer `linear` too.
  `search all` reads a Linear account once in the tracker lane, under its own key, and once in the notes lane, as
  `notes:<id>`, also when `--source` names `linear` or `linear:<account>`. A group naming `linear:<account>` holds
  its documents too, so a locked run shows and opens them; one naming only `notes:<id>` holds no issues.
- **The combined `sync` skips the documents while no folder is chosen.** With no folder and no kept documents it asks
  the provider nothing and writes no documents state, answering `documents: { skipped: "no folders chosen" }`.
- **A failed document is a partial answer that exits 0 in the combined `sync`.** It is named in `meta.issues` with
  `source` `documents`, beside the tracker's report; notion-cli's and drive-cli's documents-only `sync` still exits
  non-zero there.
