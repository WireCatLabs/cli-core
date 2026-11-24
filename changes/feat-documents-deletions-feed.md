### Added

- **A documents source from a manifest reads a deletions feed in every round of changes.** `deletions` names a call
  that lists the documents deleted since a time (Linear's audit log, where its trash leaves `updatedAt` as it was),
  and each id it names leaves the local copy as `deleted` in the next `sync`, not only after `sync --rescan`. A
  provider that refuses the feed (`permission_error`) does not fail the sync: its answer warns
  `source.deletions-unchecked`, which says `sync --rescan` finds them. A source with `deletions` passes the run's
  `warn` to `documentSourceFromManifest`, or it is refused when built
  ([a deletions feed](../docs/dev/DOCUMENTS.md#a-deletions-feed)).
