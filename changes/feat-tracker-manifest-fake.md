### Added

- **`trackerManifestContract`, `trackerManifestFixture` and `trackerManifestFake` in `@wirecat/cli-core/tracker/testing`
  run `trackerSourceContract` over a tracker source built from a manifest**, with no code for the service: a CLI made
  from `wirecat.config.ts` (linear-cli first) checks its tracker in one line,
  `for (const { name, run } of trackerManifestContract(SOURCE, { api, definitions })) it(name, run)`. The fake is
  cli-base's strict `graphqlFake` with three rows of each kind behind it, written where the map reads them and linked
  across kinds, paged by the Relay cursor, read for changes by the since, archived rows hidden unless asked for. The
  fixture brings the held ids, a dead cursor and the faults `skewed`, `change`, `archive` and `remove`
  ([TRACKER.md](../docs/dev/TRACKER.md#the-contract-kit)).
