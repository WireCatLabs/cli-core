### Fixed

- The store's write-ahead file (`wirecat.db-wal`) no longer stays at the size of the biggest write it ever held: every
  connection sets a 64 MiB journal size limit, so SQLite cuts the file back after a checkpoint. One large CRM sync had
  left a 2.2 GB file behind.
