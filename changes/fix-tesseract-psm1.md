### Fixed

- **Local OCR turns a page lying on its side.** `read_scans: local` now runs `tesseract` with `--psm 1`, its own page
  orientation detection. On the [OCR benchmark](https://github.com/WireCatLabs/cli-testing/blob/main/performance/documents/ocr-ru-en/README.md)
  a page on its side went from 85% wrong characters to 3%, every other page read the same, and a page took 0.3 s
  longer. The reading's name becomes `ocr:v2:tesseract@…`, so scans read before are read once more. Without
  tesseract's `osd` data (`apt install tesseract-ocr-osd`) it reads as before and the sync's `warnings` carry
  `document.scan-unturned` with the hint; installing the data reads the scans again.
  ([docs](../docs/dev/DOCUMENTS.md#scans-and-pictures))
