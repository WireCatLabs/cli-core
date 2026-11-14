### Changed — may break callers

- **A `readonly` level no longer stops a sync.** A command that only fetches from the service into the local store
  (`fetchesOnly`: `sync`, `messages sync`, `contacts sync`, `metadata sync`, `store gaps repair`,
  `stats messages counters sync`) runs under any `readonly` level: the profile's own key, a group key such as
  `messages`, or setup's "read only" answer. This holds on the command line, in `--dry-run` previews, in help and
  over MCP. `--sync-first` and a server search run at `readonly` too. `deny` still refuses them. A profile that
  relied on `readonly` to stop syncing now syncs; set the key to `deny` to stop it.
- **A sign-in is not a fetch.** `fetchesOnly` is false for a command marked `logsInOrOut` (`session start`), so a
  `readonly` level still refuses a sign-in, and an MCP server no longer runs one through its read tool.

### Added

- **`writesOwnerFiles(command)`** marks a command that writes the owner's files outside the store through a folder it
  does not take as an option, such as a saved job's folder. It stays a write that `readonly` stops.
- **`syncAfterInstallCases` takes `profileLevels`** (`{ variable, keys }`): for each key, the sync must run with the
  profile's own level at `readonly` and be refused at `deny`.
