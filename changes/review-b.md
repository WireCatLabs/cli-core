### Changed — may break callers

- **`stats tasks show` has no `--chat` any more: name the chat in the query, `-- chat:"Project room"`.** The query
  already took `chat:` by id or name, so the flag only repeated it, and every messenger CLI had to exempt it from
  the shared `filter-flag` lint rule until 2026-12-01. A CLI drops its `stats tasks show --chat` override when it
  adopts this version.

### Added

- **`commands --json` marks what cli-core mounted, and `ownCatalogue(program, options)` pins only a CLI's own
  commands.** Every command a shared builder made carries `"provided_by": "cli-core"`; a CLI's own commands carry
  nothing new. `ownCatalogue` from `@wirecat/cli-core/testing` takes the same options as `toolsFromCommands` and
  answers `{ "<path>": "read" | "write" }` for the CLI's own commands only: cli-core pins its own catalogue, so a CLI
  that pins this no longer rewrites its catalogue on every cli-core release. A command a CLI adds with `.command()`
  to a group cli-core built is its own; `customizeSharedCommand` keeps a changed shared command marked.
- **`openAppStore(env, { app, provider, readOnly })` opens the shared store as gcal, mail and b24 each did in their
  own `store.ts`.** A writable open writes the CLI's provider entry; a read-only one writes nothing and fails on a
  missing file or a needed migration. `registerProvider` is exported from `@wirecat/cli-core/store` too.
- **`settingsFor` takes `personal` entries: a CLI's own settings that a bot's section refuses.** A CLI that replaced
  the shared schema with `schema` only to keep such a setting out of `bot` extends the shared one instead, and takes
  every shared setting again.
- **`googleProvider(client, { loginHint })` and `googleTokenCodec` in `@wirecat/cli-core/oauth`.** Google's endpoints
  and the entry that keeps a Desktop client's secret, which gcal, mail and drive each copied.
