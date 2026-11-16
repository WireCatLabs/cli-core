### Added

- **A setup flow's check can say what `apply` keeps.** The check's result may carry `keep: { secrets, account }`:
  the value kept for a secret the answers gave (amo keeps its account address beside the token, as its
  `session start` does) and the account the profile is. Left out, `apply` keeps the secrets as typed and the
  profile's name, as before. `keep` is never printed.
