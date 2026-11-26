### Added

- **A messenger CLI can add its own notes and `--online` checks to the shared `doctor`** (experimental). `doctorNotes`
  turns the CLI's `diagnose` block into notes printed under the answer, never in the JSON. `doctorOnline` runs checks
  after the login and answers them under `online.checks` as `{ name, ok, detail }`. A failed or thrown check is a
  field, as a failed login is, and the exit code stays 0. max-cli needs both to drop its own `doctor` (stale web
  client, moved keyring, paused login, bot and PATH hints; the bot's `getMyInfo` and the MCP handshake).
