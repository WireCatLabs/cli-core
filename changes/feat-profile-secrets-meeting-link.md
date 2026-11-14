### Added

- **A profile can keep a second secret, in its one keyring entry.** `ProfileTokenStore` takes named secrets beside
  the token: `writeSecret(profile, "ssh", secret)`, `readSecret(profile, "ssh")` and `removeSecret(profile, "ssh")`,
  so a CLI can keep a database password and an SSH or SFTP password for one profile. They live in the same
  `token:<profile>` entry as one value, as an OAuth entry holds its tokens and client secret: the keyring gets no
  second entry (WC-SECR-4). An entry with only the token stays the plain value it was, so every entry written before
  reads as before. `<PREFIX>_TOKEN_<NAME>` (`secretVariable(name)`) overrides one for CI, as `<PREFIX>_TOKEN` does the
  token. Changing the token keeps the named secrets and the other way round; `remove` still forgets the whole entry,
  as `session end` wants. A run with moved folders writes them to its temporary entry and never touches the owner's
  (WC-SECR-24).
- **A link can open a call or meeting in WireCat Desktop.** `linkFor({ type: "meeting", provider, account, meeting })`
  builds `wirecat://open/v1/meeting/<provider>/<account>/<meeting>` (or the web form) from the provider's own ids, as
  a message link does: `asterisk`, the account as the provider knows it, and the call's id there. It is built only
  from that target: `meeting:<account>/<meeting>` stays a store reference and never becomes a link.
  `test/fixtures/links-v1.json` has the cases under `target_only`, since no ref names them, and two refused paths.
