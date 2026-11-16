### Fixed

- **`--from` on a search names the sender, not a date.** `search all`, `search messages` and `search conversations`
  answer `--from`, `--sender` and `--author` with `from:<sender>` in the query (in `--filter` for conversations),
  as `from:me` finds what the owner wrote. 0.672.0 answered `--from` with where the dates go.
