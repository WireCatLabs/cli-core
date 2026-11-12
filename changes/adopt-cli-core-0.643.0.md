### Added

- **A CRM's activities and tasks, read by sync and listed by `show`.** `CrmSource.activities(since, page, context)`
  (optional) gives the calls, e-mails, meetings, to-dos, tasks and comments on deals and leads changed since a time;
  `sync` reads them after the deals and leads when the owner-only setting `crm.<provider>:<account>.activities` is
  `on` (off by default), from 90 days back on the first run, and stores each as a `crm.activity` record bound to the
  kept deals and leads it names; one on none of them is not stored. `deals show` and `leads show` add `activities`,
  open ones first, at most 20. The sync answer adds `activities: { saved, out_of_scope, state }`; a source refusal is
  a gap of kind `activities`. `CrmActivity`, `CrmActivityKind` and `CRM_ACTIVITY_KINDS` are exported. No migration.

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
