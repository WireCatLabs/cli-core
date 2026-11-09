### Changed — may break callers

- **Only `bin/release` edits `CHANGELOG.md`.** The `standards` check fails a pull request that changes it unless its
  branch is one of bin/release's `release/*` branches, so a release pull request can no longer conflict and stall
  `bin/release`. Move an entry to `changes/<branch>.md` (lower case, `/` as `-`) under the changelog's `###` headings
  ([CLAUDE.md, "Committing"](../CLAUDE.md#committing)).
