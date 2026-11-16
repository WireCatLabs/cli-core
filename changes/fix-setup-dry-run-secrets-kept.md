### Fixed

- **`setup apply --dry-run` never opens the keyring.** 0.679.0 still read it when the answers reached a secret input
  and left it empty, so the shared deny contract (`cli-contract`, WC-PERM-23) could still fail. A dry run now takes
  each secret as kept: it never reports an unanswered secret as missing, so an edit that leaves the password alone can
  continue, and it still refuses a secret answer of the wrong shape. `apply` checks the secret and keeps the saved
  one when none is answered.
