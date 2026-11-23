### Added

- **Earlier versions of every synced document, and a change log (store version 72).** The store keeps a document's
  text, title and front matter before each change and before each removal, so a deleted page's last text is never
  lost. `documents history <document>` lists the versions and `--revision <n>` shows one. `changes --since 1d` lists
  what was added, changed, deleted, no longer visible, left the synced folders or came back, with titles. Both are
  local reads, so agents get them over MCP too. `documentLibraryCommands` mounts them, and `addDocumentCommands` does
  when the CLI gives `history`. A CLI with its own `documents` group calls `addDocumentHistoryCommands`
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#history-and-the-change-log)).
- **`keep_versions_for_days`, 365 by default.** A sync that completes its pass drops older versions and change log
  rows of that account. A CLI adds `DOCUMENT_HISTORY_SETTINGS` to `settingsFor` and passes `keepVersionsForDays` to
  `syncDocuments`. Without it the sync keeps one year.
- **A source can say a document is no longer visible rather than deleted.** A change takes `gone: "deleted"` or
  `gone: "unavailable"`, and `SourceIndex.remove` and `deleteFileNotes` take the reason.

### Fixed

- **Only a direct signal deletes a synced document's text.** A removal from a change feed without `gone`, a 404 or a
  refusal when the content is read, and a file a finished walk did not find now mark the document no longer visible.
  It leaves lists and search but keeps its text, and comes back as it was. Before, its text was blanked. The trash or
  `gone: "deleted"` still deletes. A file that left the scope because the owner changed the chosen folders is marked
  unsynced.
