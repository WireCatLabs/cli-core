### Fixed

- **`listedOf` labels the owner's own stored mail `Sent`.** A stored email has no folder, so mail the
  owner sent from an IMAP mailbox or without a Gmail `Sent` label looked received. A rule or a cleanup judged from
  stored mail then saw no sender the owner wrote to: "replied" was false and scores that depend on it came out
  wrong. `scoreSenders` did this step on its own; it now uses `listedOf` as it is.
