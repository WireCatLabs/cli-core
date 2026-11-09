### Added

- **One damage report for every surface (`storeDamageReport`).** `store recover` prints what happened, the likely
  causes each with the one command that tells more, the impact, that the services keep the originals, the last known
  good and what may be lost, and the steps as `{command, why, destructive}`: the first stops the writers, the last is
  the deep check. `--json` answers it as `report`, and `next` lists the steps' commands.
- **A deleted or replaced journal file is seen.** A writable open notes a `-shm` without its `-wal`, and the outermost
  commit refuses (`store.journal-replaced`) once the `-wal` it opened with is gone or is another file, since writing
  on into an unlinked journal while another process starts a fresh one damages the store. Both leave
  `<store>.journal.json`, which the report names as the first likely cause and a deep check that passes removes.

### Changed — may break callers

- **`explainDamage` is now `storeDamageReport(findings)`**, with the shape above; `store recover --json` answers
  `report` instead of `explanation`, and `doctor`'s `store.damage` takes the same shape, keeping `what` beside it
  for now.

