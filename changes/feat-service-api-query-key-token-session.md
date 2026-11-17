### Added

- **A generated `api` group signs in with an API key in the query** (`apiKey` with `in: query`), as it already did
  with one in a header. The key goes on every page of `--all`, a next link included, and never follows a redirect.
  The run record keeps only the path template, so the key never lands in a file.
- **`signRequest(manifest, operation, request, token)`** signs one request the way the `api` group and
  `serviceApiCall` do.
- **`tokenSessionCommand(options)`: the shared `session start | status | end | list`** for a service signed in with one
  token. The CLI gives its `verify` (ask the service whose the token is); the token is read hidden or from stdin,
  checked, and only then kept in the keyring or a private file. It replaces each token CLI's own `session.ts`.
