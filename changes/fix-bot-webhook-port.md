### Changed — may break callers

- **`bot watch --public-url` listens on port 9466 by default, not 8766.** WireCat Desktop gives the tools' MCP
  servers the ports 8700 to 8999, and max's MCP server has 8766, so a bot and max's server could not run at once.
  A tunnel that forwards to `127.0.0.1:8766` must now forward to `9466`, or the bot runs with `--port 8766`. A CLI
  whose own docs name 8766 as the bot's port changes them when it bumps cli-core.
