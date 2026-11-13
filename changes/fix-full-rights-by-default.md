### Fixed

- **A fresh install syncs: only the owner's own "read only" answer limits a tool.** A shared config
  (`~/.config/WireCat/config.json`) that is not JSON, starts with a byte-order mark, is a folder or holds a
  `setup` section in an older shape no longer makes every WireCat tool read-only; each profile's permissions apply.
  Before, such a file refused `sync` with "setup's answer keeps every WireCat tool read-only".
- **Setup's "read only" answer lets a sync run.** A command that only fetches from the service into the local store
  (`fetchesOnly`) is no longer refused by that answer, on the command line, in `--dry-run` previews and over MCP. A
  profile's own `readonly` level still refuses it, and every other write stays refused under the answer.

### Added

- **`syncAfterInstallCases` in `/testing`**: a CLI's sync, run as its own tests run it, with no shared config, a
  broken one, a byte-order mark, a folder, an older `setup` shape and the "read only" answer; each must succeed, and
  an optional local-only write must still be refused under "read only". The kit points `WIRECAT_CONFIG_DIR` at a
  folder of its own, so the owner's config cannot hide the failure.
