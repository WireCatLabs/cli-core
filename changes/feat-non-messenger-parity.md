### Added

- **`run()` shows the daily update line for every CLI that hands it its `appUpdate`.** Set `update` in the program
  definition (`update: appUpdate({ … })`); after a command that succeeded, `run()` prints "a newer version exists" on
  stderr, never for `--json`, a pipe, `--quiet`, `CI` or `<PREFIX>_NO_UPDATE_CHECK`. A CLI that prints the line itself
  (tg, max) leaves `update` out, or it shows twice. See
  [REFERENCE.md](../docs/REFERENCE.md#the-rule-this-package-keeps).
- **`appCompleteCommand(app, config, { sources })`: shell completion for a CLI that is not a messenger.** The same
  `complete zsh|bash|fish|powershell` and `complete -- <words>` as `completeCommand`, with commands, options and profile
  names; `sources({ profile, words, env })` adds the CLI's own names, read locally. A Tab never connects, and a failing
  source answers no names rather than a line on stderr. `completeCommand(messenger, …)` is now built on it.
- **`openCrmStore` in `@wirecat/cli-core/crm/cli`: the store a CRM command reads.** A read takes the account an earlier
  run saved; the first run, and every sync and write, open the store for writing and save the account (scope work)
  and the profile. Under `<PREFIX>_READ_ONLY` a read with no store reads an empty store in a temporary folder, so the
  lock creates no `wirecat.db`. b24 kept its own copy of this.
- **b24 in "Works with"** on every tool's first screen and in `setup`'s list of other tools.

### Changed — may break callers

- **A CRM write no longer counts against the profile's `sendsPerHour`.** A CRM limits its own rate; the guard is there
  for the levels and the journal. `CrmWrites.settings` may leave `sendsPerHour` out; a CLI that set it to
  `Number.MAX_SAFE_INTEGER` for this can drop that. A CRM CLI that relied on the limit to slow its writes must limit
  them itself.
