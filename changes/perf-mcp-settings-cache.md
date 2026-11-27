### Fixed

- **An open MCP server no longer works out all its settings again on every tool call.** It checks each call against
  the permissions in the config file, so a permission tightened there applies on the very next call. Working out all
  the settings each time read every profile's folders and the parent processes' environments: about a third of the
  CPU of the MCP tests. The server now works them out again only when the text of the config file or of the
  machine's shared config changes; it compares the text, not the file's time, so an edit in the same clock tick
  still applies at once.
