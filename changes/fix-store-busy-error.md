### Fixed

- **A store another process holds is `store.busy`, not a crash.** When a scheduled sync of one account kept the write
  lock past the busy timeout, the other account's sync failed with SQLite's raw `database is locked`, reported as
  `command.crashed`, "this is a bug", exit 1. It is now a `conflict` (exit 15) with the reason `store.busy`, in the CLI,
  over MCP and in the run record; `storeBusy` does the same for a caller's own error path.
