### Fixed

- **Every `api <operation>` answer, `mirrors preview` and `mirrors conflicts list` are marked untrusted for a
  scheduled agent.** In a run locked read-only with a mark, each generated `api` operation marks every string of the
  provider's answer, with no code in the CLI. `mirrors preview` marks the files its plan names and `mirrors conflicts
  list` each conflict's path. Elsewhere the answers are unchanged. A CLI that wrapped its `api` operations with its own
  list keeps it ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md)).
- **A marked value an agent copies into the next command works.** A locked run takes each block of its own mark off
  the command's arguments, so a marked id, path or property name reads as the text inside. A block of another mark
  stays as typed.

### Added

- **`*` in an untrusted path, for an object whose keys differ.** `properties.*.name` marks `name` under each property,
  and `properties.*` every string under `properties`, at any depth. `API_UNTRUSTED`, for a CLI's own raw call such as
  `api call`, is exported from `@wirecat/cli-core/documents/cli` ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md)).
