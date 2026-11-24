### Added

- **`addFileEditCommands` takes `creates: false`** for a provider that names a file by an id it gives, as Google
  Drive does. `sheets create` and `documents create` are then left out, since a path the user types can't name a
  new file there. The edits, `history` and `restore` stay.
