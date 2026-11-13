### Fixed

- **A mistyped profile in `<PREFIX>_PROFILE` gets the profiles here too** (`profile.unknown`), as a mistyped first
  word does, and a CLI's own "no profile named …" is no longer said twice in the message.
- **`ownCatalogue` keeps a generated Bot API command as the CLI's own**, as `commands --json` marks it, so a
  bot's contract test pins its generated commands.
