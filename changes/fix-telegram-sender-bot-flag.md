### Added

- **`Message.senderIsBot`: a messenger can say the sender is a bot account.** The store saves it as the sender
  identity's `bot` flag, so the sender goes to Bots, not People. Set it only when true. A sender the owner moved to
  People stays there.

### Fixed

- **A bot's private chat marks the bot.** When a dialog is saved with `providerMetadata.isBot = true`, the identity
  with the dialog's id that wrote in it gets `bot = 1`, so senders saved before `senderIsBot` move to Bots on the next
  chat sync. No store version ([tg-cli #932](https://github.com/WireCatLabs/tg-cli/issues/932)).
