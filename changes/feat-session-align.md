### Added

- **`messengerSessionCommands(messenger)` gives a messenger `session status` and `session list`** (WC-ACCT-12), to
  mount beside its own `session start` and `session end`. `session list` takes no profile and answers what
  `account list` answers, from this computer alone. `session status` says whether the profile has a session here and
  the account it was logged in as; `--check` asks the messenger whose the session is, without the phone number.
  `account list` stays as it is.
