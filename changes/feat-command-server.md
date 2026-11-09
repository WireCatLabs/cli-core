### Added

- `<cli> commands --serve`, in every CLI that starts through `startCli`: one long-running process that runs command
  after command, so WireCat Desktop no longer starts Node for each read on a page. One JSON request per line on stdin
  (`{"id","argv"}`), one answer per line on stdout (`{"id","code","stdout","stderr"}`, what a spawned run would have
  printed). Requests run one at a time; each is recorded as its own run, reads settings and keys again and leaves the
  store closed. A command that runs until stopped, waits on a person or reads stdin is refused with code 2. The
  server ends when stdin closes or after 10 minutes without a request. It is in no help, `commands --json` or MCP.

### Fixed

- The store's write-ahead file (`wirecat.db-wal`) no longer stays at the size of the biggest write it ever held: every
  connection sets a 64 MiB journal size limit, so SQLite cuts the file back after a checkpoint. One large CRM sync had
  left a 2.2 GB file behind.
