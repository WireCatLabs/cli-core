### Added

- **A file written only at the hash it was read at.** `guardedFileWrite` writes over a provider's file through its
  `FileTarget` only while the file still has the sha256 the caller read: the current content is downloaded into the
  profile's version store and hashed, another hash is `conflict` (`mirror.remote-changed`) with nothing uploaded, and
  the target checks it again just before the upload. What it replaced stays in the version store. The shared builder
  `addFileUpdateCommand` adds `files update <path> (--text | stdin) [--expected-fingerprint <sha256>]` to a CLI's files
  group, a remote write that asks the delete key when it replaces a file
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#write-one-file-at-the-hash-read)).
