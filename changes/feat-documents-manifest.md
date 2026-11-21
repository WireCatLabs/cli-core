### Added

- **A `files` CLI's source can come from its config.** `documentSourceFromManifest` (`@wirecat/cli-core/documents/cli`)
  answers a `DocumentSource` from the calls `wirecat.config.ts` names: the account, one file, a folder's children a
  page at a time, the changes since a time and a document's Markdown. Hooks give what the manifest cannot say, through
  the same calls. `parseCliConfig` takes a source for the `files` category, which stays optional there
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#a-source-from-a-manifest)).
- **`wirecat.config.ts` says the API's fixed headers and its paces**: `api.headers` (a header that could hold a
  credential is refused) and `api.pace`, with a slower pace for one operation in `api.pace.operations`. cli-core
  checks them; the CLI passes them to its transport.
- **A documents source can ask for a saved document to be read again** though it did not change: `reread(saved)`,
  at most 50 a pass, for a source that learned to read something later, such as a page's authors.
