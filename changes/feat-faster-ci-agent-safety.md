### Added

- **`doctorReportsCommand({ app, includes, excludes, example, check, collect })`** builds the
  `doctor reports show|create` group for a CLI that keeps its own `doctor`, so it no longer copies the builder;
  `appDoctorCommand` and `doctorCommand` use it.
- **`mayRevoke(app, env, keyring?)`** says whether a sign-out may take the sign-in back at the provider. A run with a
  moved config, state or cache folder shares the owner's keyring entry and session, so it must only forget its own
  copy (WC-SECR-24). `account remove` uses it; a CLI's own `session end` calls it before it logs out at the provider.
- **`commands --json` marks what cli-core mounted, and `ownCatalogue(program, options)` pins only a CLI's own
  commands.** Every command a shared builder made, group or leaf, has `"origin": "cli-core"`; a CLI's own commands keep
  `"handwritten"`. A reader on cli-base below 0.98.0 refuses that value, so a CLI moves to cli-base 0.98.0 with this
  version. `ownCatalogue` from `@wirecat/cli-core/testing` takes the same options as `toolsFromCommands` and
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

### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.98.0 or later (peer `>=0.98.0 <1.0.0`).** cli-core's types import
  `ListResult` from `@wirecat/cli-base/standards`, which cli-base exports only from 0.97.0 on: a CLI on an older
  cli-base installed without a warning and got `any` for every list result. And `commands --json` now writes
  `"origin": "cli-core"`, which a cli-base reader below 0.98.0 refuses. Bump cli-base with this cli-core.
- **`store reset` is no longer offered over MCP.** It needs the global `--yes`, which an MCP call cannot pass, so an
  agent saw a write tool that could only fail. MCP catalogue pins lose `store reset`; `store restore` and
  `store recover run` are listed as unavailable until `mcp.authority` is allowed.
- **Command help shows Returns only from a declared output.** A command without an output schema repeated its
  description as "Returns"; that line is now left out of `--help` and of `commandHelpMarkdown`. A command group that
  also runs on its own, such as `doctor` or `store recover`, now gets Returns, Next usually and an Example like any
  other command. Help snapshots and generated command pages change once.
- **A mistyped profile is `not_found`, with the profiles here.** A command that fails as "not signed in"
  (`authentication_error` with reason `session.missing`, `oauth.missing` or none) for a first word this computer has
  never seen as a profile now answers `not_found` with reason `profile.unknown` and `details.profiles`; the message
  keeps the sign-in hint for a profile that is new on purpose. A profile set in the environment, a bot and an MCP call
  keep the sign-in refusal.
- **Unknown commands and options carry a reason.** Commander's usage errors stay `validation_error` with the same
  text, and now give `usage.unknown-command` or `usage.unknown-option`, so a caller matches the reason, not English.
- **`stats tasks show` has no `--chat` any more: name the chat in the query, `-- chat:"Project room"`.** The query
  already took `chat:` by id or name, so the flag only repeated it, and every messenger CLI had to exempt it from
  the shared `filter-flag` lint rule until 2026-12-01. A CLI drops its `stats tasks show --chat` override when it
  adopts this version.

### Fixed

- **A store path SQLite cannot open is a configuration error.** A store path that is a folder, or one this user may
  not open, answered `internal_error` "this is a bug"; it now answers `configuration_error` with reason
  `store.unopenable` and the path.

### Security

- **`doctor reports create --output` never overwrites a file.** It wrote over any existing file, though the command
  promises it destroys nothing; it now refuses one with `validation_error` and the reason `doctor.report-exists`, as
  `store backup` does. In a CLI that names its own permission keys, `doctor reports create` is now checked against
  `doctor.reports.create` (default `ask`), as in a messenger.
- **Store file commands over MCP ask the owner first.** `store recover run`, which replaces the store file, has the key
  `store.recover.run` (default `ask`; in a messenger `deny messages` still stops it). `store restore` and
  `store recover run` can put older settings back, so they are marked as changing what a later run may do: an MCP
  server offers them only when `mcp.authority` allows it, and the read-only lock refuses them with that reason.
- **Run records mask a Bitrix24 webhook's secret.** The segment after `/rest/<user id>/` in a URL is masked in kept
  error text and in request endpoints, as a token in a query already was.
