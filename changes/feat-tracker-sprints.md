### Added

- **Trackers copy sprints.** `sprint` is a tracker kind, between `project` and `issue` in `TRACKER_KINDS`: a Linear
  cycle or a Jira sprint, with its `name`, `number`, `team`, `startsAt`, `endsAt` and `completedAt`. An issue names
  its `sprint`. `sprints list` lists them, and `issues list sprint:<id>` (or `sprint:none`) narrows the issues. An
  unnamed sprint, as most Linear cycles are, is titled `Sprint <number>`. A manifest without a sprint kind syncs as
  before ([docs](../docs/dev/TRACKER.md#the-domain)).
- **An issue in the tracker's trash leaves the copy.** A map may read `deleted` (Linear's `trashed`). A row read as
  deleted is marked deleted in the copy, and its `ids` call, which selects the same path, leaves it out, so the daily
  id pass finds it: Linear's trash moves no `updatedAt`, so a plain read of changes never sees it. An issue marked
  deleted takes its comments with it. A row the id pass lists again after it was marked deleted, as an issue restored
from the trash, is back with its comments. `trackerSourceContract` checks a
  `trash` fault, which `trackerManifestFixture` offers when the map reads `deleted`
  ([docs](../docs/dev/TRACKER.md#deleted-and-trashed-rows)).
- **The `duplicate` state type.** Linear's Duplicate state was dropped by the map, so its issues pointed at a state the
  copy did not hold. It is now one of `STATE_TYPES`, closed as `canceled` is: a task from such an issue closes as
  dismissed, `the issue was marked a duplicate in linear`, and `issues list type:duplicate` finds them.
- **A tracker sync says when it next looks for deletions and what it could not read.** Its answer has
  `deletions: { checked, due }`, when the id pass last ran for every kind and when it is next due. A kind the sign-in
  could not read is named in `meta.issues` (`tracker.kind-unread`) besides `gaps`.

### Changed — may break callers

- **`synced[].saved` and `progress.saved` count only rows that changed** in the copy: new, different, deleted or back
  again. A row read again as stored is not counted, so a sync with nothing new answers 0 and Desktop shows it up to
  date. `store.tracker.save` answers the same count.
- **`TrackerRecords` and `TRACKER_KINDS` have `sprint`, and `STATE_TYPES` has `duplicate`.** Code with a value for
  each kind or state type, such as a `Record<TrackerKind, …>` or a `switch` over `StateType`, needs one for the new
  member; `exampleTrackerRows()` has a sprint and a Duplicate state.
- **`TrackerSyncReport` has a required `deletions`**, so code that builds a report, such as a test's fake, sets it.
- **A tracker sync whose sign-in could not read a kind answers `meta.complete: false`** on every run, with the kind in
  `meta.issues`; before, only `gaps` named it. The answer's own `complete`, which Desktop reads, stays as the sync made
  it.
