### Added

- **`tokenSessionCommand` takes `entry`, for a profile that keeps more than its token.** `entry.write` makes the
  stored value from the token and `verify`'s answer, and `entry.read` gets the token back with the account. `session
  status --check` hands `verify` the token alone, and `session status` and `session list` show the account as
  `account`. An entry `read` cannot make sense of (reason `session.unreadable`) is listed as `state: "unknown"` and
  hides no other profile. Unset, the entry is the token alone, as before. hubspot moves to the shared command with it
  and keeps its sign-ins as they are, so nobody signs in again. Not with `site`. `TokenEntry` is exported from
  `@wirecat/cli-core/cli`.
