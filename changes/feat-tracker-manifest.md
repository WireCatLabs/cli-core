### Added

- **A tracker CLI can be described as data: `trackerSourceFromManifest`.** A `TrackerManifest` names, for each kind,
  the list, changes and ids operations of the generated API and maps our fields to paths in a row, in the CRM
  manifest's rule language. Over GraphQL each call may send its own selection, and `parseTrackerManifest` refuses a
  map path the selection leaves out. `wirecat.config` takes `category: "tracker"` with its `source`, and
  `spec.kind: "graphql"`. See [Trackers](../docs/dev/TRACKER.md#a-tracker-described-as-data).
