### Fixed

- **A sign-in store passes cli-base's own keyring errors through.** `credentialStorage` turned every failed read
  into `oauth.not-saved`. A `CliError` from cli-base, such as `keyring.unreachable` (the keyring failed and the file
  holds no entry), now reaches the answer with its own words. Before a sign-in, an old entry that cannot be read for
  `keyring.unreachable` counts as no old entry, so a sign-in on a machine with no keyring still saves to the file.
