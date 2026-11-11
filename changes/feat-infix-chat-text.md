### Added

- **A part inside a word in chat messages.** `*договор*` without a field, or under `text:` or `exact:`, finds «Договор», «ДОГОВОРЫ» and «переговоры» through the store's index of three-letter pieces of message text, which every store already has. A large archive no longer refuses it, and it works inside `AND`/`OR`/`NOT`, groups, and with `chat:` and `date:`. Case does not matter, and ё and е are one letter; other letters match as typed. The part needs three letters in a row. `*вор`, `*дог*вор` and `*гов?р*` use the same index and are then checked word by word; a part found in too many messages is `query.too-large`, which `chat:`, `date:` or `*part*` avoid. Mail, transcripts and file text keep the word list and its `word*` hint.

### Changed — may break callers

- **`*part*` in chat-message text no longer folds й/и or accents.** Through the word list, `*мои*` also found «мой» and `*cafe*` found «café»; through the trigram index the part matches as typed, except case and ё/е. Write the letter as the text has it, or search the whole word (`мой`), which still folds them.

### Fixed

- **A search over chats and mail together says when mail was left out.** Mail refused for a reason other than a messenger field (such as `*word*` over a large mailbox) used to drop out silently, so the answer looked complete; it is now listed under `skipped` with the reason.
- **`to:`, `cc:` and `bcc:` name themselves when nobody matches.** The error said `from:owner — nobody matches` for `to:owner`.
- **`list:` in a search without a mail account is refused** as `subject:` and `to:` are (`query.unsupported-field`, "list: is a mail field"), instead of finding nothing.
