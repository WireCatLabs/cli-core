### Added

- `CrmWrites.ownedByDefault`: a new item of these kinds is the sign-in's user's when no `--owner` is given, as Attio
  needs for a deal. With no user known, the create is refused before anything is sent.

### Fixed

- A CRM write checks `--owner` against the source's `self()` when the CLI passes no `self`, so the owner's own id no
  longer asks for `crm.assign-others`.
- A manifest write that merges a name from its parts sends a cleared part as an empty string beside the given ones,
  as Attio's name needs all three parts: `--name Madonna` and a lone `--first-name` are no longer refused.
