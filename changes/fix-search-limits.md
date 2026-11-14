### Fixed

- `search conversations` no longer fails on a long sentence over a large store: when the word half runs out of time,
  the meaning half still answers, and the answer says so (`meta.words: "out-of-time"`, a note in pretty output).
  Stop words (`что`, `какие`, `what`, `the`…) no longer go into the word half, unless the query holds nothing else.
- `search conversations` follows an explicit `--timeout`, as `search messages` does: the word half gets the longer
  time limit.
- `search messages --discover` finds a name written as one word when the question spells it with a hyphen
  (`Альфа-банк` finds `АльфаБанк`).
