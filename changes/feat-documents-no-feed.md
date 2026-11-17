### Added

- **A document source without a change feed** (Yandex Disk, WebDAV, S3): `FeedlessDocumentSource`, a
  `DocumentSource` without `startToken` and `changes`, which `syncDocuments` also takes. Every sync then walks the
  selected folders in full, saves only the files that changed since the last pass, and removes the ones a finished
  pass no longer found; an interrupted pass keeps what is held and goes on from its saved walk, and a chosen folder
  that is gone is skipped as unavailable. `feedOf(source)` tells the two apart. `documentSourceContract` checks it
  with the fixture's `change` and new `remove`, and `fakeDocumentSource` takes `feed: false`. See
  [Documents](../docs/dev/DOCUMENTS.md#a-source-without-a-change-feed).
- **A source that addresses files by path** gets the file the sync last listed: `metadata(id, known)`,
  `children(id, folder)`, `childrenPage(id, cursor, folder)`, `content(id, maxChars, file)` and `bytes(id, file)`.
  The arguments are optional, so an existing source is unchanged.
- **`documentLibraryCommands` mounts the whole shared documents set over a CLI's source** (`@wirecat/cli-core/documents/cli`):
  `folders`, `sync`, `status`, `documents`, `search`, `catalog` and the knowledge groups, with the profile's files under
  the CLI's state folder (`documentProfile`: chosen folders, sync state, walk, snapshots and the profile lock), the
  shared store, and `claimDocumentAccount`, which keeps one provider account to one profile. The CLI gives its
  source, how it files a document (`ingestion`), its words, a `documents list` row and an optional `folders browse`.
  It is what notion-cli's `src/library.ts` and `src/commands/library.ts` did, so a new documents CLI writes only its
  source. `folders add` keeps each chosen folder's metadata, which a path-addressed source reads before the first sync.
- **`fileText(bytes, file, command)` and `readableFile(file)`** (`@wirecat/cli-core/documents`): the text of a
  downloaded PDF, docx, xlsx, CSV, TSV, text or Markdown file through cli-core's readers, or a `validation_error` that
  says why there is none. drive-cli's `readFile` and `supported`, for every file source.
