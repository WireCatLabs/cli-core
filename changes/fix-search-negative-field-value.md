### Fixed

- **A search field whose value starts with a minus reads as that value**: `chat:-1001234567890 budget` searches the
  group with that id, as `chat:"-1001234567890"` did. It was refused as `query.invalid-syntax`, though the CLIs print
  a group's id with its minus. A minus before a bare word still means NOT.
