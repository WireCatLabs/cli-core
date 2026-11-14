### Added

- **A synced node can be a folder and a document at once.** `syncDocuments` takes an optional
  `isDocument(file)`: a folder it answers yes for, such as a Notion or Confluence page with sub-pages, is walked
  for its children and imported itself, a selected root page included. Without it nothing changes: Drive's
  folders are still only walked. See [DOCUMENTS.md, "Bind a provider"](../docs/dev/DOCUMENTS.md#bind-a-provider).
