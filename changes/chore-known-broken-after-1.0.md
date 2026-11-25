### Fixed

- **Parity checks the CLIs that moved to cli-core 1.0 again.** They are off the known-broken list now. Five stay on it
  until 2026-12-02 because their main is still on 0.x: drive, gcal, bitrix24, wordpress and ydisk. cli-template is
  back on it for #3365, which made the session commands cli-core's own: its MCP snapshot still lists them, and it
  adopts that with the next release.
