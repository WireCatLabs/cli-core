### Added

- **`DOCUMENT_UNTRUSTED`, `DOCUMENT_CONTEXT_UNTRUSTED` and `marksUntrusted` from `@wirecat/cli-core/documents/cli`**,
  for a CLI with its own `documents`, `catalog` or knowledge commands to mark the same text as the shared ones
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#shared-commands)).
- **`SourceWalk.deleted`**: the ids a stopped walk found deleted, so the call that resumes it removes them as
  deleted. A CLI that validates its walk file with a strict schema must accept the key; one that strips it removes
  them as `unavailable` ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#walks-over-several-syncs)).

### Fixed

- **A documents CLI marks other people's text for a scheduled agent.** The shared reads declare the names, titles,
  paths, text, excerpts and link text of a provider's files as untrusted (`DOCUMENT_UNTRUSTED`): `documents
  list|show|history`, `changes`, `search`, `folders list`, `relationships list`, `catalog show|list|search|tree`,
  and in `documents context` the document and its links but not the owner's notes, memories and facts. `files sheets
  show` and `files documents show` mark the cells and paragraphs. In a run locked read-only with a mark, that text
  now comes between the run's markers, so an agent's answers there quote it marked; elsewhere no answer changes. A CLI
  with its own copies of these commands declares the same list, exported with `marksUntrusted` from
  `@wirecat/cli-core/documents/cli` ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#shared-commands)).
- **A full walk removes a row its listing puts in the trash as deleted.** A listed row with `trashed: true` (Linear's
  archived listing, a manifest's `trashed` path) used to stay `unavailable` with its text kept for good when a
  `--rescan` saw it first; it now leaves as `deleted`, as the change feed's trashed row does, and `changes` shows it
  so. A row a finished walk does not list is still `unavailable`. A stopped walk keeps the reason in its walk file's
  new `deleted` list ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#a-trashed-row-in-a-listing)).
