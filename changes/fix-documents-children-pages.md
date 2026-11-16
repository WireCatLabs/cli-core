### Added

- **`DocumentSource.childrenPage(id, cursor?)`, an optional page-at-a-time listing for the documents sync.** A Notion
  database of 12 000 rows and more did not fit in one step, so a first sync over MCP (45 s) never got past it. With
  `childrenPage` the walk lists one page per budget step and saves the next page's cursor in the walk's stack entry
  (`SourceWalk.stack[].listing`), so the next sync goes on mid-folder. A 404 on a later page lists the folder again
  from its first page and drops nothing; only a 404 on the first page is checked with `metadata`. A source without it,
  such as drive, and walks saved before are listed as before. A cursor the provider no longer accepts must fail as
  `not_found`, and a CLI that validates its walk file must keep `listing`. `documentSourceContract` checks the pages against `children()`, and `fakeDocumentSource(account, { pageSize })`
  lists a page at a time. See [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
