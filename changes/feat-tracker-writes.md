### Added

- **A tracker CLI creates, changes and comments on issues with its own commands.** `addTrackerCommands({ writes })`
  mounts `issues create`, `issues update <issue>` and `issues comment <issue>`: a team, state, label, project or user
  is named by its id or by a name only one row of the copy has, an empty value clears a field, and a reference the copy
  does not hold is refused before anything is sent. Each write passes the profile's guard on `issues.create`,
  `issues.update` or `issues.comment`, is journaled with the `operation_id` it answers, previews under `--dry-run`, and
  stores the tracker's answer as a sync does, so `issues show` has it at once. A manifest's `writes` section maps each
  write to a mutation (Linear's `issueCreate`, `issueUpdate`, `commentCreate`); `trackerWriterFromManifest` sends it
  through `serviceApiWriter`, so the operation's own `api.*` key still applies. `trackerWriteContract` and
  `trackerManifestWriteContract` check a writer, over a fake that answers the mutations strictly by the schema
  ([TRACKER.md](../docs/dev/TRACKER.md#writes)).
