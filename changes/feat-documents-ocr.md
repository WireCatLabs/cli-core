### Added

- **A documents sync reads the text of scans and pictures.** A PDF with no text layer and a JPEG, PNG or WebP picture
  are read by OCR, chosen by the profile's `read_scans`: `local` by default (the `tesseract` program on this
  computer, Russian and English, nothing downloaded), `anthropic` or `openai` (the `ai set` model at that provider's
  own address, with pictures allowed), or `off`. At most 20 pages a file and 100 a sync. A scan an earlier sync kept
  by name is read on the next sync, and a sync with no reader says how to install one. A CLI adds
  `DOCUMENT_SCAN_SETTINGS` to `settingsFor` for its config file to take `read_scans`
  ([scans and pictures](../docs/dev/DOCUMENTS.md#scans-and-pictures)).
