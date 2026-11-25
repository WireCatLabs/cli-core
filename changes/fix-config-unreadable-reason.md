### Changed — may break callers

- **`account rename` refuses an unreadable config file with `config.unreadable`, not `account-rename.config`.** The
  family audit found one failure, "the config file cannot be read", under two names: this one and mail-cli's
  `mail.config-unreadable`. `config.unreadable` is the one name for it, and mail-cli raises it too.
