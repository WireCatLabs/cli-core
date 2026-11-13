### Fixed

- **The shared config is read with a byte-order mark.** `~/.config/WireCat/config.json` saved by a Windows editor
  starts with one; every reader of the file (setup's answer, task categories, models, search settings) refused it as
  not JSON, and a sync that reads the meaning-search model ended incomplete.

### Changed — may break callers

- **`syncAfterInstallCases` asks only "no `permission_error`" of a shared config that is not JSON or is a folder.** A
  step that reads such a file may fail and name it; the other states must still exit 0.
