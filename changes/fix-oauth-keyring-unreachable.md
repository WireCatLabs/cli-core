### Fixed

- **A keyring that does not answer is named as such, with the fix.** `credentialStorage` turned every failed read
  into `oauth.not-saved`. When cli-base reports `keyring.unreachable` (the keyring failed and the file holds no
  entry), the answer now says the OS keyring did not answer and how to fix it, with reason `keyring.unreachable`;
  the keyring's own words stay in the cause, for `--debug` and the run record. Before a sign-in with storage that
  can fall back to the file, an old entry that cannot be read counts as no old entry, so a machine with no keyring
  still signs in. With keyring-only storage the sign-in still stops before the browser.
