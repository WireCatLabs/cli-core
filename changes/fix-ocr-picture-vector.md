### Fixed

- **A picture OCR finds no text in is still found by what it shows.** With `picture_search` on and a scan reader
  set, a photo with no text was kept by name only and got no picture vector, and the next sync downloaded and read it
  by OCR again for the missing vector. It now gets its vector as a picture kept by name for its type does. Its reason
  names the reading (`OCR found no text in the file (read by ocr:v1:tesseract@5.3.0:rus+eng)`), so another engine or
  model reads it again, and the same one does not
  ([scans and pictures](../docs/dev/DOCUMENTS.md#scans-and-pictures)).
