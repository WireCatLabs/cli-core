### Added

- **`syncFileMirror` and the `FileTarget` port in `@wirecat/cli-core/documents`: two-way sync of plain files.** A CLI
  for a file store (Yandex Disk next) keeps a local folder and a remote folder the same, whole files at a time,
  binary and large files included, streamed both ways. A change on one side is copied, the same content on both is
  adopted, different changes are a conflict that `keep` (`local`, `remote`, `both`) settles; deletions go to the
  remote's trash and to `<mirror>/.wirecat-trash/`, and a run that would delete more than 50 files or a quarter of the
  mirror stops first. Every write is conditional on the last listing, so a crash at any step is settled by the next
  run. `syncFileMirrors`, `fileSyncState`, `fileMirrorStatus` and `fileRemoteChanges` (the watch lists only when the
  remote's revision moved) complete it ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#sync-plain-files-with-a-provider)).
- **`watchMirrors` takes `localChanges` instead of `kindOf` and `stateOf`**, for an engine with its own state. A
  document mirror passes `kindOf` and `stateOf` as before.
- **`scanLocal` reports each file's `size` and `mtimeMs`** and takes an optional lookup that reuses a known hash when
  both match, so a sync does not read unchanged files again. `conflictReport` adds `local_size` and `<remote>_size`
  when a conflict has them. A mirror guard's `action` can also be `delete` and `move`.

### Changed — may break callers

- **`PushConflict.url` is optional, and `MirrorWatchOptions` is a type, not an interface.** A file conflict has no
  URL, so `conflictReport` leaves `url` out when there is none; a document conflict still has one. Code that reads
  `conflict.url` as a string, or extends `MirrorWatchOptions` with `interface … extends`, needs a small change. drive
  needs none.
