### Added

- **A content write asks once.** `ContentWriteOptions.confirmed` carries the keys the `posts` command checked, and
  `contentWriterFromManifest` hands them, with the call's own `api.<operation>` key, to its `write` as a fourth
  argument. A CLI passes them to `serviceApiWriter(...)(command, operation, input, { confirmed })`, so a terminal
  publish asks the owner once; a key the command did not check (the publish key for a post published at the source
  since the last sync) is still asked, and `deny` or `readonly` still refuse.
