### Added

- **`syncFileMirror` and the `FileTarget` port in `@wirecat/cli-core/documents`: two-way sync of plain files.** A CLI
  for a file store (Yandex Disk next) keeps a local folder and a remote folder the same, whole files at a time,
  binary and large files included, streamed both ways. A change on one side is copied, the same content on both is
  adopted, different changes are a conflict that `keep` (`local`, `remote`, `both`) settles; deletions go to the
  remote's trash and to `<mirror>/.wirecat-trash/`, and a run that would delete more than 2 files and also more than
  50 or a quarter of the mirror stops first. Symbolic links are never followed, and a file system without hard links
  (exFAT, FAT, FUSE, SMB) works through exclusive copies. Every write is conditional on the last listing, so a crash at any step is settled by the next
  run. `syncFileMirrors`, `fileSyncState`, `fileMirrorStatus` and `fileRemoteChanges` (the watch lists only when the
  remote's revision moved) complete it ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#sync-plain-files-with-a-provider)).
- **A file mirror deletes only what it can prove was deleted.** The last sync saw the file, the side's listing is
  complete, and the side's root is the same folder (the remote root's id; the local folder's device and inode, and
  not empty while the state has files, as an unmounted drive is). Anything else is reported as `unknown` and the run
  is partial, with a root problem reported as an error even at a first sync. Files under a symbolic link are
  `unknown` too, as is a file moved remotely to a path the mirror refuses. When the owner confirms a replaced root
  is the right folder, `repin: true` records it again and runs a first sync that deletes nothing and settles no
  conflict; a mirror whose root was not replaced ignores it. A download cut off midway stays a conflict until its
  partial file is moved away.
- **`fileVersions`: a local version store for mirrors.** Before a sync overwrites or deletes a local file, its content
  is kept by sha256 under the profile's state folder, with an append-only log of every change both ways; versions stay
  30 days, and a deleted file's last version stays for good; a version kept just before a crash stays 30 days too.
  `restoreFileVersion` puts one back under the sync lock.
- **`watchMirrors` takes `localChanges` instead of `kindOf` and `stateOf`**, for an engine with its own state. A
  document mirror passes `kindOf` and `stateOf` as before.
- **`scanLocal` reports each file's `size` and `mtimeMs`, and the symbolic links it skipped in `links`,** and takes an optional lookup that reuses a known hash when
  both match, so a sync does not read unchanged files again. `conflictReport` adds `local_size` and `<remote>_size`
  when a conflict has them. A mirror guard's `action` can also be `delete` and `move`.

### Changed — may break callers

- **`PushConflict.url` is optional, and `MirrorWatchOptions` is a type, not an interface.** A file conflict has no
  URL, so `conflictReport` leaves `url` out when there is none; a document conflict still has one. Code that reads
  `conflict.url` as a string, or extends `MirrorWatchOptions` with `interface … extends`, needs a small change. drive
  needs none.
