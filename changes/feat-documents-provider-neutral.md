### Added

- **Any documents provider gets documents accounts, not only Google Drive.** A CLI whose provider entry has
  kind `documents` (and is not `imported`) can call `notes.documentsAccount` and `documentIngestion({ provider })`
  for its own principals, and `documentsAccounts()` lists them beside Drive's. A document whose front matter names
  such a provider in `source` is kept as Drive's are: placed by its catalog parents, never joined by content to a
  copy in a notes folder, and its `sourceUrl` and `modifiedAt` stand in when no file row gives them. `google-drive`
  is now in the provider seed, so Drive behaves the same before drive has written its entry. See
  [DOCUMENTS.md, "Bind a provider"](../docs/dev/DOCUMENTS.md#bind-a-provider).
