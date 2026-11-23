### Fixed

- **A file mirror no longer merges edits to neighbouring lines.** Two changes with no unchanged line between them,
  one on each side, are now a conflict, as in Git's merge. They used to be combined silently. This includes an
  insertion right after the other side's edit, and edits to neighbouring Markdown blocks such as two list items.
  Changes with at least one unchanged line between them still merge, and a checklist tick still merges with a text
  edit. Document push keeps merging neighbouring blocks as before
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#plain-files-both-ways)).
