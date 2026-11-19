### Added

- **Issues assigned to you become your tasks.** A tracker sync (Linear first) now makes each open issue assigned to the
  signed-in user a task, so it shows in memo's and Desktop's task lists with no new screen. The task's title is the
  issue's key and title (`ENG-12 Fix login`) and follows later renames. It closes, with a reason, when the issue is
  completed, canceled, archived, deleted, unassigned or assigned to someone else, and opens again when the issue comes
  back to you. A task you closed yourself stays closed, one you reopened is not closed again, and nothing is written
  back to the tracker. `issues assign` tasks now carry the title too. The sync's answer says what it did in `tasks`
  ([TRACKER.md](../docs/dev/TRACKER.md#an-issue-as-the-owners-task)).
- **`trackerSourceContract` checks `self()`**: when a tracker has it, it names one of the tracker's users.
  `fakeTrackerSource` takes `self`, and `trackerManifestFake` answers `self` with its first user.
