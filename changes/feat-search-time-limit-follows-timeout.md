### Added

- **`search messages --timeout 30s` may search for up to about 29 seconds.** A search stopped at 2 seconds whatever
  time its caller gave the run, so a valid query over a large store failed in WireCat Desktop. With an explicit
  `--timeout` (or `<PREFIX>_TIMEOUT`) the search uses that time less a second to answer; the error's `limit_ms` names
  the limit that applied. Without one it stays 2 seconds, for agents and MCP too.
