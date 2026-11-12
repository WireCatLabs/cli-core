### Security

- **`doctor reports create --output` never overwrites a file.** It wrote over any existing file, though the command
  promises it destroys nothing; it now refuses one with `validation_error` and the reason `doctor.report-exists`, as
  `store backup` does. In a CLI that names its own permission keys, `doctor reports create` is now checked against
  `doctor.reports.create` (default `ask`), as in a messenger.
- **Store file commands over MCP ask the owner first.** `store recover run`, which replaces the store file, has the key
  `store.recover.run` (default `ask`; in a messenger `deny messages` still stops it). `store restore` and
  `store recover run` can put older settings back, so they are marked as changing what a later run may do: an MCP
  server offers them only when `mcp.authority` allows it, and the read-only lock refuses them with that reason.

### Changed — may break callers

- **`store reset` is no longer offered over MCP.** It needs the global `--yes`, which an MCP call cannot pass, so an
  agent saw a write tool that could only fail. MCP catalogue pins lose `store reset`; `store restore` and
  `store recover run` are listed as unavailable until `mcp.authority` is allowed.
- **Command help shows Returns only from a declared output.** A command without an output schema repeated its
  description as "Returns"; that line is now left out of `--help` and of `commandHelpMarkdown`. A command group that
  also runs on its own, such as `doctor` or `store recover`, now gets Returns, Next usually and an Example like any
  other command. Help snapshots and generated command pages change once.

### Added

- **`doctorReportsCommand({ app, includes, excludes, example, check, collect })`** builds the
  `doctor reports show|create` group for a CLI that keeps its own `doctor`, so it no longer copies the builder;
  `appDoctorCommand` and `doctorCommand` use it.
