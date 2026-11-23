### Added

- **A file mirror merges text files both sides changed, and its conflicts can be resolved.** A `.md`, `.markdown`,
  `.txt`, `.csv` or `.tsv` file up to 1 MB that changed on both sides since the last sync is merged line by line
  (Markdown also by blocks, so a checklist tick and an edit of the same item merge) and written to both sides, in
  every mirror; CRLF, a byte-order mark and other encodings pass through byte for byte. Lines both sides changed
  differently stay a conflict, now recorded in the mirror's state: `listFileConflicts`, `showFileConflict` (the three
  versions, the conflicting lines and the file with conflict markers) and `resolveFileConflict` (keep a side, both,
  or a final file, refused with nothing written when either side changed since), mounted by `fileConflictsCommand`
  as `mirrors conflicts list|show|resolve`. The contents of every merge, conflict and resolution are kept for good,
  and `versions list` names each one's role ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#plain-files-both-ways)).
