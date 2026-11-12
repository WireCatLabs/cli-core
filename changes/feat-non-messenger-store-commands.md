### Added

- **Every CLI on the shared store can back it up, check it and repair it.** `addStoreMaintenanceCommands(store, { app },
  profile)` mounts the store file's commands — `store info`, `check`, `migrate`, `rebuild`, `backup`, `restore`,
  `decrypt`, `repair`, `reset`, `copies delete`, `tables list`, `recover` — on a CLI's own `store` group; they were
  only in a messenger's `storeCommand`. Without a `provider` they say "local store" and nothing about chats.
  `addCrmCommands` mounts them under its `store`, so b24 has them with no change of its own. See
  [REFERENCE.md](../docs/REFERENCE.md#the-rule-this-package-keeps).
- **`doctor reports show|create` in `appDoctorCommand`.** A CLI that is not a messenger writes the same problem report
  as `doctorCommand(messenger)`: what `doctor` answers and the newest failed run (or `--run <id>`), every id a label,
  the home folder as `~`, mode 600; it holds no send journal.

### Fixed

- **`runScopeCases` counts a command group that has an action of its own**, as `doctor` beside `doctor reports`, so a
  CLI's `doctor` entry in `commands` or `skip` stays valid now that `appDoctorCommand` has subcommands.
