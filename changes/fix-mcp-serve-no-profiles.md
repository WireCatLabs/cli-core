### Fixed

- **`<tool> mcp serve --profiles all` starts on a computer with no profile yet.** It answers the handshake and lists
  the same tools a profile's own server lists (`<tool>_tools_search`, `<tool>_read`, and `<tool>_write` where a
  command writes), each taking `profile`, and every call is refused with a `configuration_error` that names the
  command to set up the first profile: `<tool> personal setup`, `<tool> personal session start` for a CLI that signs
  in with a session, or `<tool> personal …` for one with neither. Before, it exited before the handshake, so
  directories such as Glama, which start the server in an empty container to read its tools, marked WireCat servers
  as not deployable. Nothing picks or makes a profile: which tools are listed never follows a profile's permissions,
  so the list is built from the program itself. `mcp serve` with no profile named, and `--profiles` with a name that
  does not exist, are still refused.
