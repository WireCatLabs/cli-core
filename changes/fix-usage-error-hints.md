### Fixed

- **A usage error says how to fix the call.** An unknown flag that a sibling command takes names it
  (`unknown option '--like' — --like is an option of search conversations`). `--filter` on `search messages` and
  `search all` says the filter goes in the query. A query that fails after `--` quotes the words read as the query and
  says to put options before `--`: an unknown option there (`messages list -- -100… --around 5419`) used to fail as
  bare `query.invalid-syntax at position 2`.
