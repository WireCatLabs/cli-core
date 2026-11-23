### Added

- **New Word and Excel files: `createXlsx`, `createDocx`, and `files sheets create` and `files documents create`.**
  `createXlsx({ sheets: [{ name, rows }], boldHeader? })` makes a workbook from rows of values (numbers and booleans
  typed, a text that starts with `=` stays text), `createDocx({ paragraphs: [{ text, style? }] })` a document with
  `Title`, `Heading1` to `Heading3`, `Normal` and `ListBullet` styles; the same input gives the same bytes. The
  commands, mounted by `addFileEditCommands`, write a new file only (`office.file-exists` points to `update`), ask the
  write's own permission and answer the `sha256` that `update` takes next. See
  [New files](../docs/office.md#new-files) and [New Office files](../docs/dev/DOCUMENTS.md#create-office-files).
