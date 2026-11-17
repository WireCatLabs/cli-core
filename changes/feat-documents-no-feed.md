### Added

- **A document source without a change feed** (Yandex Disk, WebDAV, S3) leaves out `startToken` and `changes`. Every
  sync then walks the selected folders in full, saves only the files that changed since the last pass, and removes
  the ones a finished pass no longer found; an interrupted pass keeps what is held and goes on from its saved walk.
  `documentSourceContract` checks it with the fixture's `change` and new `remove`, and `fakeDocumentSource` takes
  `feed: false`. See [Documents](../docs/dev/DOCUMENTS.md#a-source-without-a-change-feed).
- **A source that addresses files by path** gets the file the sync last listed: `metadata(id, known)`,
  `children(id, folder)`, `childrenPage(id, cursor, folder)`, `content(id, maxChars, file)` and `bytes(id, file)`.
  The arguments are optional, so an existing source is unchanged.
