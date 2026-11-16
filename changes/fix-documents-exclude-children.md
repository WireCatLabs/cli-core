### Changed — may break callers

- **A saved `exclude` query that matches a page with sub-pages, or a folder, drops the whole branch** (`inScope`,
  `within`). The sub-pages stayed in the documents and were listed at the top of the catalog with no parent; the next
  sync now removes them. A file that also sits under a parent the query keeps stays. `within` takes an optional `cut`
  after `seen`. See [Bind a provider](../docs/dev/DOCUMENTS.md#bind-a-provider).
