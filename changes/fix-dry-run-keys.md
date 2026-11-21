### Fixed

- **`messages sync --dry-run` previews and names its permission key where it cannot estimate.** Its own estimate
  needs one chat named, no `--all`, `--last` or `--since-time`, and message ids that count messages. Any other
  dry run, such as the command's own example with `--last 100` or a messenger whose ids are ordered by time, was
  refused, so the deny-keys contract could not learn its key. It now gets run's preview: the permission key, and no
  connection or sign-in.

