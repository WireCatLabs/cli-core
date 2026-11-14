### Added

- **Shared documents commands, in `@wirecat/cli-core/documents/cli`.** `addDocumentCommands(program, options)` mounts
  `folders add|list|remove`, `sync`, `status`, `documents list|show|export|context`, `search`, `catalog`, `tags`,
  `relationships`, `notes`, `memories`, `facts`, `identities` and `mirrors` over the CLI's own ports, so every
  documents and wiki CLI has the same commands, options and answers. One builder per group
  (`addDocumentFolderCommands`, `addDocumentSyncCommands`, `addLocalDocumentCommands`, `addDocumentSearchCommand`,
  `addDocumentCatalogCommands`, `addDocumentKnowledgeCommands`, `addDocumentMirrorCommands`) lets a CLI put its own
  groups between them. `words` names the CLI and its provider: the remote side's word (`mirrors sync --keep
  local|<remote>|both`, `identities link <remote>-id`), and the store provider an issue names. The answers use the
  same entity names in every CLI (`document` in the `imported` and `catalog` views, `document_tag`,
  `document_relationship`, `document_identity`, `selected_folder`, `mirror`). The `documents` group the builders
  return takes the CLI's live subcommands (`get`, `create`, …), and `folders` takes its own `browse` outside the
  shared contract. `catalog tree` reads the account's catalog once, page by page, with no cap on the total, and any
  entry can have children (a page with sub-pages). drive-cli's commands, moved here
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#shared-commands)).
- **A documents contract kit, in `@wirecat/cli-core/documents/testing`.** `documentSourceContract` checks a
  `DocumentSource` adapter (identity, the folder walk, content, the change feed, `not_found`), and
  `documentCommandsContract` checks a CLI's shared commands over its fakes: every shared path mounted and still
  cli-core's, the remote word, and sync → list → show → search, tags and notes. `fakeDocumentSource` is a provider in
  memory.
- **The shared documents commands' error reasons are cli-core's.** `catalog.unavailable`, `catalog.not-found`,
  `catalog.depth-invalid`, `catalog.cycle`, `mirror.none`, `mirror.not-found`, `mirror.not-folder` and
  `export.exists`. An app may still list one of them with the same code, as a CLI released before the move does; a
  copy with another code is still refused.
