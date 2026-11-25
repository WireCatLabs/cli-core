### Added

- **`issues search` finds issues, projects and comments by meaning too**, once `sync --embed` built their vectors, and
  ranks them as the `tracker` lane of `search all` does: the same lane, now `searchTracker` in
  `src/services/search-all-tracker.ts`. A question finds what holds some of its words. Each hit has `found_by`;
  searched by words only, the answer says why in `missing` (`field: found_by`) with a `sync --embed` step
  ([TRACKER.md](../docs/dev/TRACKER.md#commands)). The linear rivals benchmark found 7 of 27 with this command and 27
  of 27 with memo's `search all` over the same copy
  ([cli-testing](https://github.com/WireCatLabs/cli-testing/blob/main/performance/tracker/linear-rivals/README.md)).
- **A label, state, user, team or project made after the last sync is found for a write.** A deleted one is not. `issues create` and
  `issues update` look a name the copy lacks up in one `changes` call from that kind's last sync cursor, and keep the
  row in the copy; with no cursor, or more changes than one page, the refusal says it is not in the copy and to run
  sync. A name no row has is refused with the nearest names as `candidates`, each with its team.

### Fixed

- **`issues list` filters by name.** `label:Bug`, `state:"In Progress"`, `assignee:"Ada Owner"`, `team:ENG`,
  `project:"Billing revamp"` and `sprint:12` match a name in any letter case, or the id as before; a name several
  rows have (every team's "In Progress") matches each. An unknown name is `tracker.reference` with the nearest names
  in `candidates`, no longer an empty list. `TrackerFilter`'s `assignee`, `project`, `state`, `label` and `sprint`
  take several ids too.

### Changed — may break callers

- **A quoted argument to `issues search` is words in any order, not a phrase.** `issues search "invoice currency"`
  now matches as `issues search invoice currency` does, as its help says. Quote marks inside the query
  (`'"invoice currency"'`) still match a phrase, as in `search all`. A query naming a field (`from:`) is refused.
- **An `issues list` filter value the copy holds no row of is refused** (`validation_error`, `tracker.reference`)
  instead of answering no issues. A caller that passed an id of a row not yet synced gets the error and runs sync.
