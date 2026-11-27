### Fixed

- **`session list` is the first line under `Next:` on a tool with no `setup`.** The first help screen put it below
  `Start here:`, and a tool without that line, such as cli-template's `clidev`, showed it with no label above `Next:`.
  A tool with `setup` keeps it below `Start here:`.
