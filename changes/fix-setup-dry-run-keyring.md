### Fixed

- **`setup apply --dry-run` opens the keyring only when the answers reach a secret.** It read every secret's saved
  state up front, so a dry run of the first step touched the keyring, and the shared deny contract (`cli-contract`,
  WC-PERM-23) failed amo's `contracts:check` once 0.678.0 let an empty dry run through.
