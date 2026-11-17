### Fixed

- **`schedule command` and `schedule agent` help no longer shows a messenger's commands in a CLI that is not a
  messenger.** b24 showed `-- messages list <chat> --limit 50` and `b24 personal search messages 'date>1d'`, which it
  does not have. A CLI with `messenger: false` now shows `-- doctor` and `b24 doctor`: these CLIs share no search or
  sync command, and every CLI has `doctor`.
