### Fixed

- **Under `<PREFIX>_READ_ONLY`, a first run writes no starter `config.json`.** The settings are read as the defaults
  instead, as for a dry run. Without the lock, the file is still written on a first run.
