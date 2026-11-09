### Added

- **Runs say what they wrote to the store.** Each outermost write transaction that commits logs one `store.write`
  event per table and change, `{kind: "store", table, op, n}`: counts only, read from the statement text and SQLite's
  change count, so every writer is covered and no CLI passes anything. A success that wrote the store is kept for
  `keep_store_runs_for_days` (default 3) even where `record: false`, Desktop or a server would not keep it
  (`kept_because_store`). Past 100 in a run, they are summed by table and change into one event each at its end; the
  run lists its `tables`. `search runs kind:store table:emails` finds them.

