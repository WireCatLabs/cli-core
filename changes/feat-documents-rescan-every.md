### Added

- **A documents source can ask for a full walk every so often.** A manifest's `rescanEvery` (such as `"7d"`) makes a
  plain `sync` walk the chosen folders in full, as `--rescan` does, once that long has passed since the last full
  walk. A Linear document restored from the trash, which neither its changes nor its deletions name, comes back without
  `--rescan`. The sync that starts the walk says why in its answer (`rescan`). Unset, nothing changes.
  ([docs](../docs/dev/DOCUMENTS.md#a-full-walk-every-so-often))
