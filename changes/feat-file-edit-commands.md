### Added

- **Office files edited in place, and earlier versions put back.** `addFileEditCommands` mounts under a CLI's files
  group `sheets show|update` for .xlsx cells, `documents show|update` for .docx paragraphs, `history` for what this
  profile's writes replaced, and `restore <path> [version]`, besides `update`. A show gives the file's sha256; every
  edit and restore takes it as `--expected-fingerprint` and writes through `guardedFileWrite`, so a change made
  meanwhile is a conflict with nothing uploaded and the replaced content is kept. The Office editors' refusals pass
  through with their reasons ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#edit-office-files-in-place)).

### Changed — may break callers

- **`files update` refuses a .pdf, .docx or .xlsx** (`file.not-plain-text`): a read gives their extracted text, which
  would replace the whole document. A CLI leaves the sha256 out of a truncated or extracted text read
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#write-one-file-at-the-hash-read)).
