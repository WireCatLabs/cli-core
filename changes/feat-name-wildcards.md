### Added

- **Part of a name in `from:`, `to:`, `cc:`, `bcc:` and `chat:`.** An unquoted value with `*` or `?` is a pattern over names, aliases and @usernames (titles for chats; addresses too in mail): `from:Ярослав*` finds «Ярослав» and «Ярослав Орлов», `from:*Орлов*` anyone with it inside, `chat:*отчет*` every chat with it in the title. The search reads them all. Case, ё/е and letter forms do not matter. A pattern that fits nobody is `not_found` with the nearest names; more than 50 fits is `query.too-large`. An id and an exact name work as before.
- **An ambiguous name lists more choices.** When several people are named exactly as typed, the error's candidates also list the people whose name only contains it, so «Ярослав» offers «Ярослав Орлов» too.
- **Wildcards in `mailbox:`, `label:` and `tag:`, and a word's start in `subject:`, `content:` and `transcript:`** (`mailbox:Proj*`, `tag:work-*`, `subject:отчет*`, `content:накладн*`).
- **A bare word's start looks where a bare word does.** `invoi*` without a field now also finds the word in voice transcripts, file text and file names, as `invoice` does, and says where (`matched_in`).

### Fixed

- **`*word*` in the text names the way out.** A pattern that starts with `*` reads every indexed word; over the expansion budget its error now suggests `word*`, which also finds the word's forms.
