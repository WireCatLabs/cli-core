# Editing Office files in place

`@wirecat/cli-core/office` changes cells of an Excel workbook (`.xlsx`) and paragraph text of a Word document
(`.docx`) without rebuilding the file. It is for a service with no document API, such as Yandex Disk: the CLI
downloads the whole file, edits it here and uploads the whole file back. Fonts, styles, images, comments, tracked
changes and every part the editor does not read come back as they were. It also makes a new workbook or document from values
(see [New files](#new-files)).

```ts
import { editDocxParagraphs, editXlsxCells, readDocxParagraphs, readXlsxCells } from "@wirecat/cli-core/office"

const [sheet] = await readXlsxCells(bytes, { sheet: "Budget", range: "A1:D20" })
const { bytes: edited } = await editXlsxCells(bytes, [{ sheet: "Budget", cell: "B7", value: 1200 }])

const paragraphs = await readDocxParagraphs(bytes)
const result = await editDocxParagraphs(bytes, [
  { index: 3, text: "New text" },
  { insertAfter: 3, text: "A new paragraph", styleFrom: 0 },
  { delete: 5 },
])
```

## How the file stays the same

- **The zip is not packed again.** Every entry the edit does not change is copied byte for byte: its local header,
  compressed data, data descriptor and directory record. A changed part is compressed again (deflate level 6) under
  its old name, time and extra fields. A part the edit removes (an Excel calculation chain) leaves the archive.
- **XML is not written again from a tree.** The editor finds the elements it changes by their position in the part's
  text and replaces only those characters. Namespace declarations, attribute order, quotes and the elements around
  an edit stay as they were. New elements use the prefix the file already uses (`w:`, `x:` or none).
- **The result is checked before it is returned.** Each changed part must parse again, and the new file must read
  back with the edited values: through the editor's own reader, and for a workbook through the shared spreadsheet
  reader too. The same edit of the same file gives the same bytes.
- Only UTF-8 parts are edited. A part stored in another encoding is refused, since writing it back as UTF-8 would
  contradict its declaration.

## Workbooks

`readXlsxCells(bytes, { sheet?, range? })` returns each sheet with its stored cells: the A1 address, the value
(string, number, boolean or `null`), the type (`string`, `number`, `boolean`, `error`, `date`, `empty`), the formula
without `=` when there is one, and the format index (`style`). A formula cell's value is its last calculated result.

`editXlsxCells(bytes, edits, { overwriteFormulas? })` takes `{ sheet, cell, value }` edits:

- A string goes into the shared strings: an identical plain entry is reused (never a rich-text one, whose bold or
  coloured runs would come along), otherwise one is added at the end and
  `count` and `uniqueCount` follow. An existing entry is never changed, because other cells may point at it. A
  workbook without a shared strings part gets an inline string. A string that starts with `=` stays text.
- A number is stored as written; it must be finite. A boolean is stored as `1` or `0`. `null` empties the cell and
  keeps its format.
- The edited cell keeps its format index and its other attributes. A new cell or row goes in address order, and the
  sheet's `dimension` grows to cover it. A new cell takes the row's format when the row has one, otherwise none.
- A formula cell is refused unless `overwriteFormulas` is set. Even then, a formula that other cells share (the
  master of a shared formula) and a cell of an array formula are refused: replacing them breaks the other cells.
- The workbook is marked to calculate again when it opens (`fullCalcOnLoad`), so Excel shows the new result of a
  formula that reads an edited cell. LibreOffice follows its own "Recalculation on File Load" setting instead: a
  headless LibreOffice 26.2 showed the old result (checked 2026-11-23). Until a recalculation the stored results of
  those formulas are the old ones, and `readXlsxCells` shows those. When a formula was replaced, the calculation chain (`calcChain.xml`, its
  relationship and its content type) is dropped, and Excel builds it again; `calcChainDropped` says so.
- A header or totals cell of an Excel table is refused: the table part repeats its text, and Excel reports the file
  as damaged when they differ. The table's other cells can be edited. A cell with a picture or a linked data type
  (`vm`) is refused. A row or a cell that has no address in the file is
  refused as a place for a new row or cell, because every later position would shift.

The result lists each change with the value before and after and whether the cell is new.

## Documents

`readDocxParagraphs(bytes)` returns the paragraphs of the document body, table cells and content controls included,
in document order. Each has its `index`, `text` (a tab is `\t`, a line break `\n`), `styleId` and the style's
`style` name from `styles.xml`, `location` (`body` or `table`), `editable` with a `reason` when it is not, and
`mixedFormatting` when its runs are formatted differently. Headers, footers, footnotes and text boxes are not
listed.

`editDocxParagraphs(bytes, edits)` takes edits whose indexes all refer to the document as it was read:

- `{ index, text }` replaces the paragraph's text. The paragraph keeps its properties (style, numbering, alignment,
  spacing, a section break) and its start tag. The new text is one run with the formatting of the first run that
  had text. **Mixed inline formatting collapses:** a bold word or a coloured phrase in the old text is not carried
  over, and `collapsed` lists every replaced paragraph where this happened. Bookmarks of the paragraph are kept,
  starts before the text and ends after it, so cross-references still find them. Spelling marks are dropped.
- `{ insertAfter, text, styleFrom? }` adds a paragraph after `insertAfter` (`-1` puts it before the first), in the
  same table cell or content control; before the first paragraph of a document that starts with a table, that is
  the table's first cell. It copies the paragraph properties and first run's formatting of `styleFrom`,
  which defaults to the paragraph it follows. A section break is not copied, and neither are the paragraph's ids.
- `{ delete }` removes a paragraph. Refused when it ends a section, holds a bookmark, or would leave the body or a
  table cell ending without a paragraph (after a table, say). Word expects that paragraph, and LibreOffice's text
  export never finishes on a body that ends in a table (checked 2026-11-23).

Only a paragraph made of plain runs can be replaced or deleted. A paragraph is refused, with the reason, when it
holds a tracked change (insertions, deletions, moves, changed formatting), a field, an image, drawing or embedded
object, a footnote or endnote reference, a comment, a hyperlink, a content control inside it, a symbol, an equation,
a page or column break, or any element the editor does not know. A paragraph inside a locked or data-bound content
control is refused too. One call refuses two edits of the same paragraph. Text with a character XML cannot store (a
control character other than tab and newline) is refused; `\r\n` becomes `\n`.

## New files

`createXlsx` and `createDocx` build a new file from values, with the fewest parts Excel, Word, LibreOffice and the
readers above take. The same input gives the same bytes: the zip has a fixed time and no document properties (no
author, no creation time).

```ts
import { createDocx, createXlsx } from "@wirecat/cli-core/office"

const workbook = createXlsx({
  sheets: [{ name: "Budget", rows: [["Item", "Cost"], ["Rent", 950], [null, true]] }],
  boldHeader: true,
})
const document = createDocx({
  paragraphs: [
    { text: "Quarterly report", style: "Title" },
    { text: "Revenue", style: "Heading1" },
    { text: "Revenue grew 12%." },
    { text: "Rent", style: "ListBullet" },
  ],
})
```

- **Workbook.** One worksheet per sheet, rows from A1. A string goes into the shared strings part (a repeated text
  once), a number and a boolean are typed, `null` leaves the cell out. A string that starts with `=` stays text: there
  is no formula. `boldHeader` puts the first row of every sheet in a bold font. A sheet name must have 1 to 31
  characters, none of `[ ] : * ? / \`, must not start or end with `'`, and must differ from the others ignoring
  case (`office.invalid-sheet-name`). A number must be finite and a text at most 32,767 characters
  (`office.invalid-value`); the sheet holds at most 1,048,576 rows and 16,384 columns (`office.invalid-cell`).
- **Document.** One paragraph per entry, on an A4 page. The styles part defines `Normal` (the default, Calibri 11),
  `Title`, `Heading1` to `Heading3` and `ListBullet`, under Word's own names (`heading 1`, `List Bullet`), so Word,
  LibreOffice and mammoth treat them as built in: mammoth gives `h1` to `h3` and a `ul` list. A tab is `\t`, a line
  break `\n`. No paragraphs give one empty paragraph, which a body needs.
- Text with a character XML cannot store (a control character other than tab and newline) is refused.

Not made: formulas, column widths, number formats (a date is a number or a text), merged cells, tables, images,
headers and footers, numbered lists, inline bold or links.

## Limits

The file must be a plain `.xlsx` or `.docx` (not a macro-enabled or template file, not encrypted), at most 50 MB
unpacked, 10 MB in one XML part and 1,000 zip entries — the limits of the shared document reader. Zip64 archives
are refused. Refusals are `validation_error` with a `reason` that starts with `office.`.
