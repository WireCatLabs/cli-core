### Fixed

- **`doctor reports` declares that it has no effects.** A CLI whose test demands effects on every group no longer
  needs its own override for it (zoom, drive).
- **A command that runs itself beside its subcommands keeps its help lines.** `doctor` (and `commands`) lost Returns
  and Example in `--help` and `docs/commands.md` once `doctor reports` was added; both lists now include it.
- **`doctor reports show` and `create` say what they return.** Returns no longer repeats the one-line description.
- **Parity: `pnpm generate` breaks the downstream check when it fails.** The tests read the contracts it writes, so a
  failed generate showed up as a misleading test failure; only `docs:check` still warns.
- **`bin/release --app-ref <branch>` builds an app without that branch on its main** and says so in a warning,
  instead of failing the release for an app that needed no adoption.
