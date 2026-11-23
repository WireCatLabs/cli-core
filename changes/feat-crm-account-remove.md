### Added

- **`account remove` for every CRM CLI, with its guard.** `addCrmCommands({ account })` mounts cli-core's
  `account remove`, which refuses `--delete-data` while another profile here holds the same account, whose one copy
  the store shares (`account-remove.account-shared`); `--dry-run` warns instead. `refuseTakenCrmAccount` and
  `crmAccountClaim` (the `claim` of `tokenSessionCommand`) refuse a sign-in to an account and user another profile is
  signed in to (`session.duplicate`), and a profile named `files` or `foreign-contacts`, the folders every account
  shares (`profile.reserved`). A `held` hook says which account a profile holds; unset, it is the account
  `session start` remembered. bitrix24-cli, amo-cli and hubspot-cli can drop their own copies
  ([CRM.md](../docs/dev/CRM.md#one-account-one-profile)).
- **`tokenSessionCommand`'s `claim` gets the run's keyring** as its fifth argument, so a check of the other profiles'
  sign-ins reads the same keyring a test hands in.
