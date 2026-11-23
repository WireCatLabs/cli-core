### Added

- **Edit `.xlsx` cells and `.docx` paragraphs in place** (`@wirecat/cli-core/office`), for a service with no
  document API that downloads and uploads whole files, such as Yandex Disk. `readXlsxCells` and `editXlsxCells` work
  by sheet and A1 address: shared or inline strings, numbers, booleans and empty cells, the cell's format kept, new
  cells and rows in order, formula cells refused unless `overwriteFormulas`, and the workbook marked to calculate
  again on open. `readDocxParagraphs` and `editDocxParagraphs` replace, insert or delete body and table-cell
  paragraphs, keeping each paragraph's properties and its first run's formatting (mixed inline formatting
  collapses, and the result lists where); a paragraph with tracked changes, a field, an image, a comment, a link or
  a footnote is refused with the reason. Only the changed XML is spliced in; every other zip entry is copied byte for
  byte ([Editing Office files](../docs/office.md)).
