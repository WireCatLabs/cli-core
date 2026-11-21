### Changed — may break callers

- **`account rename` of a profile that is not here fails with `profile.unknown`.** It had its own reason,
  `account-rename.unknown-profile`, with the same code and message as `account remove`'s, and the family audit
  counts one failure under two names as a new finding, which blocked `cli-dev audit --family` of every CLI on
  cli-core. `profile.unknown` is what the rest of the tool gives for a profile that is not here, with the same
  `details.profiles`; `account remove` keeps `account-remove.unknown-profile`, which WireCat Desktop matches. An
  agent that matched `account-rename.unknown-profile` matches `profile.unknown` instead.
