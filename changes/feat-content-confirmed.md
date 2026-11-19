### Added

- **A content write asks once.** `ContentWriteOptions.confirmed` carries the keys the `posts` command checked, and
  `contentWriterFromManifest` hands them, with the call's own `api.<operation>` key, to its `write` as a fourth
  argument. A CLI passes them to `serviceApiWriter(...)(command, operation, input, { confirmed })`, so a terminal
  publish asks the owner once; a key the command did not check (the publish key for a post published at the source
  since the last sync) is still asked, and `deny` or `readonly` still refuse.
- **`contentManifestFake` in `@wirecat/cli-core/content/testing`.** A content service in memory, built from a CLI's
  own source manifest and generated API, as `crmManifestFake` is for a CRM: the contract kits and the CLI's `sync` run
  over it without a hand-written fake of the service.
