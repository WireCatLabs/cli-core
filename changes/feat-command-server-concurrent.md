### Added

- **`commands --serve` runs up to 8 requests at once** ([protocol](../docs/REFERENCE.md#the-command-server)). The
  ready line says how many (`"concurrent":8`); the protocol stays 1, so a client that sends one request at a time
  works as before. Each request keeps its own output, stdin, exit code and run, and opens the store on its own
  connection; a `store` command runs alone. WireCat Desktop's Memory page sends 7 reads together, and today a pool of
  2 servers starts a fresh process for the other 5. `EntryContext.setExitCode(code)` sets a request's exit code in a
  CLI with its own program; a direct `process.exitCode` write is one value for the whole process.
