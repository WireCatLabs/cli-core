### Fixed

- **`parity.json` has rows for `messages scheduled cancel`, `edit` and `send`** (max and tg; WhatsApp has no scheduled
  messages). 0.706.0 added the commands without rows, so the parity manifest check failed for max-cli and tg-cli,
  hidden only because both were listed as known broken.
