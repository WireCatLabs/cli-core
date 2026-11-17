### Added

- **Issue trackers get their own category: `@wirecat/cli-core/tracker`.** A tracker CLI writes one `TrackerSource`
  and gets the copy in the shared store (store version 70: `tracker_items` and the word index `tracker_item_words`),
  `syncTracker` (changes by cursor, deletions by a daily id pass, a run budget that resumes where it stopped),
  `addTrackerCommands` (`sync`, `issues list|show|search|task`, and `projects`, `teams`, `users`, `states`, `labels`
  lists), and `/tracker/testing` with `trackerSourceContract` and `fakeTrackerSource`. `issues task` makes an issue
  the owner's task by a link, copying only its key. See [Trackers](../docs/dev/TRACKER.md).
