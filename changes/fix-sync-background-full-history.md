### Fixed

- **`messages sync <chat> --full-history --background` reads the chat in full.** The background job was started
  without `--full-history`, so a group above `history_group_members_max` ended at once with `fetched: 0` and
  `limited: "group_too_large"`, and its log asked for the flag that was given. The job now gets the flag, and
  `store jobs retry` keeps it (tg-cli [#916](https://github.com/WireCatLabs/tg-cli/issues/916)).
