### Fixed

- **A command's own `--fields` is no longer read as `--json`'s field list.** A generated Google API command such as
  `gcal <profile> api calendar-events-list --fields 'items(id)' --json` failed with "--json takes comma-separated field
  paths", because the command's `--fields` (Google's partial-response mask) stood in for the root's. Only
  `--json=a,b` now picks the answer's fields, in `outputFor`, `baseContext` and the program's own output.
