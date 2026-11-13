### Added

- **A records envelope carries text search finds: the record type `document`.** Fields `text`, `title`, `created_at`,
  `updated_at`, `url` and `metadata`; relations `about` people, organizations, deals and events (a call, or a meeting's calendar event). It
  becomes a document of the envelope's own account, keyed by the record's external id: the same record again is
  `unchanged`, changed text is the same document's next revision, and a `delete` empties it. Like an SMS or a call, it
  is taken only under an import-only provider. A document's `fields` may take 1 MiB; every other type keeps 64 KiB.
- **The seeded import-only provider `import`** holds what any other source brings in: `import:crm-notes`,
  `import:obsidian-export`. It holds documents, SMS and calls.
- **Search reads the documents of import-only accounts under their own name.** An import-only provider (`phone`,
  `import`) holds `documents` beside its other kinds: notes search, `search all` and meaning search read them,
  `--source phone:office-pbx` reads only that account's, and a hit names `phone:office-pbx` with kind `document`.
  The account's SMS and calls stay listed under the same name.


### Changed — may break callers

- **An import-only provider holds `documents` beside its own kinds.** `kindsIn("phone")` is now
  `["messages", "events", "documents"]`, and `holdsKind(provider, "documents")` is true for `phone` and `import`. So
  `--source documents` reaches their accounts, and `search notes --source phone:<account>` is read where it was refused.
- **`searchNotesOf(...).accounts` names an import's account by its own key** (`{ provider: "phone", account:
  "office-pbx" }`): its `provider` is a `string`, no longer only `"notes"`. Every import-only account is in the list
  of what an unscoped notes search read, one that holds only SMS and calls included.
- **`TABLE_RECORD_TYPES` holds `document`**, so a CSV sheet and `records templates` offer it. SMS and calls still
  have no sheet.

### Fixed

- `searchNotesOf` hands its `env` to the search, so meaning search finds the models of the caller's state folder
  instead of the process's.
