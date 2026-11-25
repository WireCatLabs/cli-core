### Added

- **`store.people.listBots` and `showBot`** read the sender bots: by name, by part of a name, address or username, or by
  the organization they send for (`organization:<id>`). `showBot` adds every move to or from the bot. memo and Desktop
  build their bots list on them.

### Changed — experimental

- **Bots are their own entity, apart from people (store version 75).** A sender bot (`sender-bot:<id>`) now holds its
  identities itself, in `sender_bot_identities`: an identity belongs to one person or one bot, never both. Its messages
  and mail keep pointing at the identity. A bot never appears in `people.list`, its counts, `people.similar` or
  `people.ties`; `people list kind:automated` keeps the people a name or a bulk mailbox marks. The upgrade moves every
  version 74 bot's identities off its person row. That row stays, hidden, so a move back gives its uid back, and its
  `person:` ref still names the bot in a move. `minCompatible` stays 73: triggers keep a 1.0 build from giving a bot's
  identity a person again, and the next list settles a bot such a build sorts.
- **`SenderBot` describes the bot itself**: its name, identities, organization, author, reason, counts, reach and
  signals, and no longer `person`. `moveToPerson` gives each identity back to the person it came from unless `person` is
  named. Both moves take `sender-bot:<id>`, `person:<uid>` or an identity.
- **`people.list` rows lose `bot`**, and `KindSignal` loses `owner-choice`: no listed row is a bot.
