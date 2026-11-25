### Added

- **Sender bots, apart from people (store version 74).** A program that writes to the owner becomes a `sender_bots`
  row. That covers a no-reply or alert address, a messenger bot, and a service's signed automatic mail. A bot is never
  proposed as the same person and never offered by `people.similar`. It has no ties, and `tasks.assign` refuses it
  with `sender-bot.assignee`. The owner's `store.people.moveToBot` and `moveToPerson` move a person, a bot or one
  identity for its whole history. The owner's choice wins over the rules, and every move is logged in
  `sender_bot_moves`. See [ARCHITECTURE.md, "Sender bots"](../docs/dev/ARCHITECTURE.md) and
  [schema.md](../docs/storage/schema.md#sender_bots).
- **A page of people reads its List-Ids through an index** (`emails_by_list_id`). It no longer reads the List-Id of
  every stored email.

### Changed — experimental

- **`people.list` rows have `bot`**: `sender-bot:<id>` for a sender bot, else `null`. A bot is still listed as
  `automated` under its `person:<uid>` ref, so `people list kind:automated` and `people show` keep working. A bot's
  `ties` are empty.
- **`KindSignal` gains `owner-choice`**: the signal of a bot the owner made when nothing else marks it.
- **`KIND_RULES` goes to 7.** The first list after the upgrade works out every kind again and moves the programs it
  finds.
