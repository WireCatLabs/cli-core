### Added

- **A file mirror works with a remote that rewrites the text it is sent.** A `FileTarget` with `rewrites: true` (Notion,
  which keeps a page as blocks and gives back its own Markdown) no longer turns every upload into a conflict. When an
  upload reads back with other bytes, the mirror keeps the local file's version, writes the remote's form into the
  local file while it is unchanged, and logs it. Both sides then hold the same bytes, so the next sync compares and
  merges against one base. `mirrors conflicts resolve` does the same with the final content. The result lists such
  files in `rewritten` ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md)). Without `rewrites`, nothing changes (#3232).

### Changed — may break callers

- **A file mirror keeps earlier versions for 365 days, not 30.** `fileVersions(dir, now, keepForDays)` takes the
  period, so a CLI passes the profile's `keep_versions_for_days` (`keepVersionsForDays(settings)`), as documents
  history does. Without it the default is 365 days, the owner's rule for every sync. A mirror's version store grows
  for longer: yandex-disk-cli users keep a year of replaced files unless they set a shorter period.
- **`FileTarget.exists` answers false only for a real deletion.** A provider that cannot tell a deletion from lost
  access throws instead, and the file is left alone as unknown. yandex-disk-cli's target already answers that way.
  It also gets the file's id from the last sync, so a provider that keeps ids across a move can tell a file moved out
  of the folder from a deleted one.
