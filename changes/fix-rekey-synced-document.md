### Added

- **`rekeySyncedDocument`** (`@wirecat/cli-core/documents/cli`) moves a synced document to the new id a provider gave
  the file after a replace, so the owner's tags, the notes about it and its links follow the file. A sync that ran in
  between and filed the file anew is folded into the old document; a failure only warns. Behind it, the documents
  ingestion's `rekey` and `renameFileNote(…, { fold: true })`
  ([DOCUMENTS](../docs/dev/DOCUMENTS.md#write-one-file-at-the-hash-read)).

### Fixed

- **A target's own conflict keeps its words.** `guardedFileWrite` and a mirror's sync replaced every `conflict` from
  `upload` with "changed since it was read; nothing was written", even when the target had done something and said
  so. A conflict with a reason other than `mirror.remote-changed`, such as the new `upload.replace-interrupted`, now
  reaches the caller unchanged.
