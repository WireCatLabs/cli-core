### Fixed

- A failed schedule's desktop notification says since when it fails, why, and the command that shows what is wrong
  (`max work doctor`), above the log's path, instead of only "failed (exit 12)" and a path the notification cuts off.
  The Telegram and e-mail notices name the same command (template variable `check`).
- A run that cannot read its sign-in no longer only says the keyring was locked: the notice says it is locked or holds
  no sign-in, and to sign in again when the computer is unlocked.
