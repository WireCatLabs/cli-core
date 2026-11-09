### Changed — may break callers

- **`messages sync --all` leaves out muted chats.** A chat the messenger reports muted (`muted`, with no
  `mutedUntil` or one still ahead) is not read, so a sync of an account with many muted groups no longer downloads
  them all. The answer counts them in `limited.muted` and leaves them out of `chats`, `items` and the progress total;
  a note says how to read them. Messages already stored stay. A chat named (`messages sync <chat>`) is read as
  before, and one kept in full with `--full-history` is read by `--all` too. To read them again, pass the new
  `--with-muted` to `messages sync --all` for one run (a background job keeps it), or set the new profile setting
  `history_muted` to true.
