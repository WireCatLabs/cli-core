### Changed — may break callers

- **A file mirror asks before more than 10 deletions or 50 replacements, whatever its size.** The deletion guard no
  longer lets a share of a big mirror through (40 deletions out of 1,000 files used to pass): more than 10 deletions
  stop the run. More than 50 replacements of existing files, on either side, stop it too, as an editor rewriting
  every file or ransomware encrypting the folder would. `allowReplacements` allows them like `allowDeletions`. The
  stop is no longer thrown: the mirror's result carries one `confirmation_required` error at path `.`
  (`mirror.too-many-deletions` or `mirror.too-many-replacements`), so the other mirrors still sync and a watch reports
  it at every cycle. Its message names the counts and the one command that allows them; `MirrorHints` gains `sync`,
  `allowReplacements` and `exclude`, and fills `<id>` and `<count>`. See
  [DOCUMENTS.md](../docs/dev/DOCUMENTS.md#plain-files-both-ways).
- **`FileTarget` needs `exists(path)`.** A file missing from a complete listing is deleted locally only once a
  direct read after the listing finds nothing there, so a page that shifted while it was read, or a lagging flat
  listing, never deletes a file. A remote that changes all the time still has its deletions proven: no listing has to
  stand still.

### Added

- **Mirror exclusions.** `Mirror.exclude` (and `FileMirrorOptions.exclude`) takes globs, read by `excludedBy` and
  checked by `exclusionPattern`. An excluded path is skipped on both sides and is never deleted: adding an exclusion
  trashes nothing, and removing one syncs the path as a new folder. `fileMirrorStatus` leaves excluded paths out.
- **A file mirror checks free space before it writes.** A run that would leave less than 1 GB free on the drive it
  downloads into, or on the version store's drive, stops with `mirror.no-space` and the bytes it needs. The local
  scan takes up to 100,000 files, and a big state is saved less often.
