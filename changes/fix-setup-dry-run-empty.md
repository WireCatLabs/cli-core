### Fixed

- **`setup apply --dry-run` with nothing on stdin answers instead of refusing.** It checks no answers and names the
  first step in `at`, so a program can ask where a flow starts, and the shared deny-keys contract
  (`cli-contract`) can run it: amo's `contracts:check` failed with "setup apply --dry-run exited 2". `setup apply`
  without `--dry-run` still refuses an empty stdin.
