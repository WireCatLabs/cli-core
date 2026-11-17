### Fixed

- **A chosen folder moved on a path-addressed provider comes back once it is added again under its new path.**
  `documentLibraryCommands` read the folder's old path from the last sync before the one `folders add` had just read,
  so the folder stayed unavailable for good. `folders add` now keeps a chosen folder's new metadata (without changing
  its date), and that copy wins.
