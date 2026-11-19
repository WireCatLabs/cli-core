### Added

- **The generated `api` group mounts subgroups: `api <group> <command>`.** An operation whose manifest names a `group`
  (cli-base's `names.groups`) is mounted under it without the repeated word, so `contacts-list` in `contacts` is
  `api contacts list`, checked against `api.contacts.list`; `api.contacts` covers the whole group. A profile that still
  names the old flat key `api.contacts-list` keeps its hold on that one command: it is checked beside the new key, from
  the command line and over MCP, warns to rename it, and only ever tightens. The old path `api contacts-list` stops
  working. `api show` takes the path (quoted, `api show "contacts list"`), the old name or the operation id, and `api list` prints the path and the group.
  A manifest without groups mounts flat, as before, so nothing changes until a CLI regenerates with groups and
  releases the move as a breaking change.
