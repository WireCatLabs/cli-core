### Fixed

- **`bin/release` publishes when main has only `changes/` fragments and no `## Unreleased`.** With the version taken on
  npm it looked for `## Unreleased` to put the next version under, found none and stopped before publishing 0.620.0.
  It now adds the new version's heading above the newest one and collects the fragments into it.
