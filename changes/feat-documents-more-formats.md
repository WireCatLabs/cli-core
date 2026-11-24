### Added

- **A documents sync reads every format cli-core's readers read.** `readableFile` now takes Word 97–2003 (`.doc`),
  RTF, HTML, OpenDocument (`.odt`, `.ods`, `.odp`), PowerPoint (`.pptx`) and EPUB beside PDF, docx, xlsx, CSV, TSV,
  plain text and Markdown, so Yandex Disk and other CLIs built on it no longer keep them by name only. Images and
  scans stay by name only.

### Fixed

- **A file an older version kept by name as `unsupported type: …` is read on the next sync** once its type is
  readable, even when the file did not change. A file whose read failed (damaged, no text layer) is not read again.
