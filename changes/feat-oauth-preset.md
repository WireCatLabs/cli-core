### Added

- **`oauthPreset(flow, options)`: an installed app's browser sign-in from the flow a spec declares.** `oauthFlowOf(manifest)`
  reads the OpenAPI authorization code flow; a GraphQL service writes the same object by hand. Each scope the CLI asks
  for must be one the flow lists, with a "did you mean" for a typo. The redirect stays the CLI's choice: the spec cannot
  say which one the app registered.
- **`oauthSessionCommand(options)`: the shared `session start | status | end | list` for a browser sign-in.** PKCE on
  the loopback, the CLI's `verify` and `claim` before anything is kept, refreshes under one lock, `--no-browser` and
  `--credential-storage file`. In a run with moved folders, `session end` says the owner's sign-in stays.
