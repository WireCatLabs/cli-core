### Fixed

- **A release makes its GitHub release again.** The release workflow pushed only the tag, so GitHub's releases page
  stopped at the last release made by hand. The `tag` job now creates the release from the version's changelog
  section, as the CLIs' release workflows do. 1.x was backfilled by hand.
