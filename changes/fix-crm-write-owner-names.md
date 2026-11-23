### Added

- `CrmWrites.ownedByDefault`: a new item of these kinds is the sign-in's user's when no `--owner` is given, as Attio
  needs for a deal. With no user known, the create is refused before anything is sent.
- `CrmWrites.self` may be a function, asked only when a write needs the sign-in's user, so a CLI whose sign-in does
  not name that user still checks `--owner` against it.

### Fixed

- A manifest write that merges a name from its parts sends a cleared part as an empty string beside the given ones,
  as Attio's name needs all three parts: `--name Madonna` and a lone `--first-name` are no longer refused.
