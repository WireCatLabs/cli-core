### Changed — may break callers

- **A saved `exclude` query that matches a page with sub-pages, or a folder, drops the whole branch.** The sub-pages
  stayed in the documents and were listed at the top of the catalog with no parent; the next sync now removes them,
  and the sync no longer lists what is below an excluded folder. A file that also sits under a parent the query keeps
  stays. A selected folder the query matches drops only its own row, as before. Once the folder stops matching, the
  next sync brings the whole branch back. See [Bind a provider](../docs/dev/DOCUMENTS.md#bind-a-provider).
- **`inScope` and `within` take `folders: Record<string, M>`**, the type of the files they check, instead of
  `Record<string, SourceFile>`; `within` is generic and takes an optional `cut` after `seen`.
