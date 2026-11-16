### Fixed

- **An option an agent guesses on a search or a message read fails with the form that runs.** `search all`, `search
  messages`, `search notes` and `search conversations` answer `--since`, `--after`, `--until`, `--before` (and
  `--from`, `--to`) with where the date goes (`date>=…` in the query, or `--since-time` and `--filter` for
  conversations), `--around` with `messages context <hit ref> --before-n 5 --after-n 5`, and `--only` with
  `search all … --only`. `messages list`, `show` and `context` answer `--chat` with the chat as the first argument,
  and `context` answers `--before` and `--after` with `--before-n` and `--after-n`. Before, commander said a bare
  "unknown option", or suggested an unrelated near name (`--since` → `--source`); each guess cost an agent a call.
