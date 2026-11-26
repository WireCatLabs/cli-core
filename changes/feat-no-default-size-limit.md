### Added

- **`readWhole()` reads a file past 2 GiB into one buffer**, where `readFile` stops with `ERR_FS_FILE_TOO_LARGE`.
- **`sizeText()` says a byte budget as people read it**: `10 GiB`, `250 MiB`.

### Fixed

- **A file is read for its text up to 10 GiB by default, not 50 MiB.** The 50 MiB default refused large PDFs and
  documents from Drive, Yandex Disk, CRM files and attachments. `MAX_FILE_BYTES` and `attachmentMaxBytes()` are now
  10 GiB, and `MESSAGING_ATTACHMENT_MAX_MIB` still sets another budget
  ([attachments](../docs/attachments.md#configure-pdf-previews-and-larger-files)). The same budget now covers editing
  an Office file in place (it was 64 MiB) and what a DOCX, XLSX or EPUB unpacks to, so pictures inside one no longer
  make it unreadable. The text parts are still read up to 50 MiB unpacked, the guard against a zip bomb. A file
  within the budget is held whole in memory, so a caller that used `MAX_FILE_BYTES` as a memory bound now allows 200
  times more. Read the budget with `attachmentMaxBytes()` so the setting applies.
- **A documents sync reads a file an earlier version kept by name for its size** (`file is larger than …`) once the
  budget allows it. Before, such a file stayed kept by name until it changed.
