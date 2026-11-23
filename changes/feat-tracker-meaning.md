### Added

- **`search all` finds issues, projects and comments by meaning.** A tracker's issues, projects and comments get
  chunks as notes do (`tracker_item`), kept in step by `save` and `removeUnlisted`, and `embedTracker` embeds them
  with the shared text model. The tracker lane fuses words and meaning by reciprocal rank, says how it searched under
  `tracker: { by, meaningSkipped? }`, and marks each hit's `foundBy`. A tracker CLI's `sync --embed` embeds new items,
  the combined sync with documents too, within the deadline; a model not downloaded keeps the sync's answer and is
  named in `meta.issues`. Items synced before are embedded at the next `sync --embed`
  ([TRACKER.md](../docs/dev/TRACKER.md#search-all)).

### Fixed

- **A documents `sync --embed` stops embedding before the run's deadline.** `embedNotes` now gets the deadline the
  sync had, so `--timeout` bounds the embedding too and the answer says when it stopped
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#walks-over-several-syncs)).
