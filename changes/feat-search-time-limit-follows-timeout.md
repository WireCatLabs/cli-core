### Added

- **`search messages --timeout 30s` may search for up to about 29 seconds.** A search stopped at 2 seconds whatever
  time its caller gave the run, so a valid query over a large store failed in WireCat Desktop. With an explicit
  `--timeout` (or `<PREFIX>_TIMEOUT`) the search uses that time less a second to answer; the error's `limit_ms` names
  the limit that applied. Without one it stays 2 seconds, for agents and MCP too.

### Fixed

- **A file's link that a program guessed waits for review again.** Since 0.621.0 every unconfirmed relationship a
  file wrote became reported by the file's account, a guess (`provenance: "scan"`) included. Only a link whose
  provenance names the file's own source, such as Drive's owner and last editor (`google-drive:files.get`), is
  reported now.
