### Added

- **One name per concept across searches.** `sender:` is `from:`. `title:` is the chat's title in message search (a
  part of it, in any letter case), the subject in mail (as `subject:`), and stays the title in notes and files. The
  query guide has one table of the title, author, date and presence fields of every search. See
  [query-language.md, "Поля"](../docs/search/query-language.md#поля).
- **`field:*` and `_exists_:field` ask whether a message has a value.** In message and mail search `from:*`,
  `title:*`, `subject:*`, `to:*`, `cc:*`, `bcc:*`, `topic:*` and `participants_count:*` keep the messages that have
  one; `chat:*` and `date:*` keep every message. Another field's `*` is refused with what to write instead, such as
  `has:file` or `has:link`.
- **`tasks list` finds a task by words of its title.** A bare word, or `title:request`, finds "Review the request";
  each word is found inside the title in any letter case, and `title:req*` still matches the title's start.
- **`contacts list email:` and `phone:`.** A part of a contact's address or phone, the phone compared by its digits:
  `phone:+34` and `phone:600-11` both work, since a `+` right after a field's colon is now read as the value's sign
  in every list query.
- **`search all title:` finds deals and leads by their title only.**
- **Errors say what to write instead.** `chat:Альфа*` that fits no chat is `not_found` with reason `query.no-match`
  and suggests `chat:*Альфа*` or the closest name; a chat, people or contact search shorter than three characters
  is `query.short-text` with a hint; `title:*встр*` in events and notes says `title:встр` already finds it inside a
  word.

### Changed — may break callers

- **An unknown field is refused, not searched as words.** `status:open`, `assignee:ana` and any other lowercase
  Latin name of three letters or more with a value that names no field of the search is `query.unknown-field`. The
  error names the search's fields, or the list that filters by it (`tasks list status:open`,
  `deals list stage:<value>`), and the quoted form that finds the words (`"status:open"`). `10:30`, `HH:MM`, `a:b`,
  `итог:договор` and links stay words. `search all stage:won` now refuses the whole search instead of skipping deals.
  A saved search with such a term refuses when it runs.
- **A notes field in message or mail search is refused.** `site:`, `lang:`, `author:`, `keyword:` and `source:`
  found nothing there and said nothing; they are now `query.unsupported-field`, as a mail field is without mail.
  In `search all` the messages lane is skipped with that reason.
- **A boost is refused.** `invoice^2` searched for the text "invoice^2" and found nothing; it is now
  `query.unsupported-operator` with the query to retry: `invoice`, or `"invoice^2"` to find the text as written.
  `x^2` as text is written in quotes.
- **`after:` and `before:` refuse with reason `query.legacy-date-field`**, renamed from `legacy_date_field`: a reason
  is a dotted name, and the old one could not be registered.

### Fixed

- **Every message search is about 15 times faster on a large store.** The coverage step counted and dated every
  message of every chat on each search (0.45 s at 1M messages); it now reads the trigger-kept count and each chat's
  newest message off its time index. `договор*` at 1M messages: 478 ms before, 31 ms after
  ([measurement](https://github.com/WireCatLabs/cli-testing/tree/main/performance/search/coverage-step)).
- **A word-end pattern answers once its page is full.** `*ени` and `*ость` without `chat:` or `date:` were refused
  before any message was checked; the candidates are now checked in the answer's order and stop at the page, so the
  budget refuses only a page it cannot fill. That refusal names the pattern (`term`) and suggests `*part*`, more of
  the word, `chat:` or `date:`.
- **`bin/verify-query-reference` passes on JDK 25.** Java's default object ids in Lucene's printed nodes are
  normalized before comparing.
