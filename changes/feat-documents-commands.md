### Added

- **Shared documents commands, in `@wirecat/cli-core/documents/cli`.** `addDocumentCommands(program, options)` mounts
  `folders add|list|remove`, `sync`, `status`, `documents list|show|export|context`, `search`, `catalog`, `tags`,
  `relationships`, `notes`, `memories`, `facts`, `identities` and `mirrors` over the CLI's own ports, so every
  documents and wiki CLI has the same commands, options and answers. One builder per group
  (`addDocumentFolderCommands`, `addDocumentSyncCommands`, `addLocalDocumentCommands`, `addDocumentSearchCommand`,
  `addDocumentCatalogCommands`, `addDocumentKnowledgeCommands`, `addDocumentMirrorCommands`) lets a CLI put its own
  groups between them, and each honours a global `--dry-run`. `words` names the CLI and its provider: the remote
  side's word (`mirrors sync --keep local|<remote>|both`, `identities link <remote>-id`), and the store provider an
  issue names. The answers use the same entities and fields in every CLI: `document` in the `imported` and `catalog`
  views, `document_tag`, `document_relationship`, `document_identity` (`remote_id`, `provider`, `role`, `person`),
  `selected_folder` and `mirror`. The `documents` group the builders return takes the CLI's live subcommands (`get`,
  `create`, …), and `folders` takes its own `browse` outside the shared contract. drive-cli's commands, moved here
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#shared-commands)).
- **`catalog tree` reads only what it shows.** Each shown entry's children come from the store by parent, 1 000 a
  page, and the branches cut at `--depth` are checked 200 at a time. Any entry with children can be a root or a
  branch, so a page with sub-pages works. An entry in two folders is shown in full once and marked `repeated` at its
  other place. Over 10 000 entries the answer is `catalog.tree-limit`, which says to name a smaller folder or lower
  `--depth`.
- **A documents contract kit, in `@wirecat/cli-core/documents/testing`.** `documentSourceContract` checks a
  `DocumentSource` adapter: identity, the folder walk, content and bytes, the change feed with a change in it
  (`change`), `not_found`, and pages that are folders and documents at once (`isDocument`).
  `documentCommandsContract` checks a CLI's shared commands over its fakes: every shared path mounted, still
  cli-core's and not overridden, its effects, the remote word, and sync → list → show → search, tags and notes by id.
  `fakeDocumentSource` is a provider in memory.

### Changed — may break callers

- **The shared documents commands' error reasons are cli-core's.** `catalog.unavailable`, `catalog.not-found`,
  `catalog.depth-invalid`, `catalog.cycle`, `catalog.tree-limit`, `mirror.none`, `mirror.not-found`,
  `mirror.not-folder`, `export.exists` and `listing.too-large`. An app that lists one of them under the same code
  still starts, as a CLI released before the move does. An app that lists one under another code fails at start.
- **`sync.partial` names no provider:** "some sources did not sync; the next sync retries them".
