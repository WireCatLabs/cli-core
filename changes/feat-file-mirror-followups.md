### Added

- **A file mirror keeps the remote content it replaces, too.** Before an upload overwrites a remote file, or a
  deletion trashes it, the old content is kept in the mirror's version store, downloaded first when the store does
  not have it. Each log entry says in `from` which side its `old` content came from. When the store cannot keep a
  content, the file fails with `mirror.version-not-kept` and nothing is replaced; a remote file that changed since
  the listing fails with `mirror.remote-changed` ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#sync-plain-files-with-a-provider)).
- **`skippedName` in `@wirecat/cli-core/documents`,** so a target skips `.git`, `node_modules` and editor leftovers
  while it lists. `syncFileMirror` takes `hints` to name the app's own preview, repin and allow-deletions commands in
  its messages.
- **`syncFileMirrors` and `restoreFileVersion` take the lock `acquireLock` returns.** Its `held()` is checked before
  every write; a caller no longer keeps its own flag. A lock with `assertHeld` works as before.

### Fixed

- **A download that replaced a file is never reported as cut off.** Only a new file can be left partial, so only a
  new file's interrupted download makes the path a conflict. A download that fails cleanly clears its pending entry,
  and a leftover temporary file under a symbolic link is left alone. The error for an empty local folder says what
  to do: mount it, or add a file or remove the mirror's state when the files really were deleted.

### Changed — may break callers

- **`FileVersions` has `has(sha256)`, and `keep` takes a writer as well as a path.** Code that implements
  `FileVersions` itself adds `has`; `fileVersions()` has both. `FileMirrorOptions.assertHeld` may return a promise.
