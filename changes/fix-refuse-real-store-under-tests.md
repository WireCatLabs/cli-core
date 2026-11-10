### Fixed

- **A test can no longer reach the owner's real store through `openCache` either.** The refusal of 0.560.0 covered
  `openStore` and `openSqlite`; `openCache` and `openFile`, which first-run, store settings, schedules and store
  backups use, opened the file without it. The check now sits in both SQLite drivers, so every opening under vitest
  refuses a file in the owner's WireCat folder.
