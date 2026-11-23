### Changed — may break callers

- **`mirrors conflicts resolve` runs inside the app's run.** `FileConflictCommands.connect(command, mirror, body)` now
  takes the body and runs it inside the app's run, so a resolve is bounded by `--timeout`, kept by `--record` under its
  own name, and its requests land in that run. Before, `connect` answered the connection and the resolve ran outside
  any run. A CLI that mounts `fileConflictsCommand` wraps `body(connection)` in its own run, as its `mirrors sync`
  does; `FileConflictConnection` is the type it hands over (#3230).
- **The Office edit refusals keep their own reason, spelled like every other reason.** `office.formula_cell` and the
  other `office.*` reasons were not registered, so the CLI and MCP showed `input.invalid` in their place, and the
  registry refuses an underscore. They are registered now and use hyphens: `office.formula-cell`,
  `office.wrong-format`, `office.invalid-cell`, `office.no-sheet` and the rest
  ([Editing Office files](../docs/office.md)). Code that compared `details.reason` with the old spelling compares
  with the new one.

### Fixed

- **The shared `changes` command passes the command lint.** With cli-base 0.129.0 or later, whose vocabulary has the
  view `changes` and the flags `--since <time>` and `--event <events>`, and the `--until <time>` cli-core 0.724.0
  takes, a documents CLI needs no lint override or audit difference for it. cli-core's own command lint now mounts
  `documents history` and `changes`, so a new finding fails here first (#3229).
