### Added

- **`<tool> <profile> account rename <new>` gives a profile another name and keeps it signed in.** It moves the
  profile's keyring entries (cli-core's `token:<profile>` and the tool's own), its config sections, its files, the
  store's record of which account it is, and its entries in account groups; the account's messages stay where they
  are. It reuses the `account remove` hooks, asked for the old and the new name, plus one new optional hook,
  `signIn`, that names where the sign-in lives. `--dry-run` lists the moves; it asks first, or `--yes`. It refuses a
  taken name, a profile a serve, service, schedule or sync uses, a bot profile, and a run with moved folders.
  A messenger gets it by setting `accountRemoval.signIn`; another CLI mounts `accountRenameCommand(app, removal)`
  beside `account remove` ([guide](../docs/dev/ACCOUNT-REMOVAL.md#renaming-a-profile)).
