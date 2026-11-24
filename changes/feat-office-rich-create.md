### Added

- **`sheets create` makes several sheets, formulas and bold cells.** `--values` also takes
  `[{"name": "Budget", "header": true, "rows": [...]}]` for several sheets, and a cell may be
  `{"formula": "SUM(B2:B3)"}` or `{"value": "Total", "bold": true}`. Excel and LibreOffice compute the formulas when
  the file opens. A text that starts with `=` still stays text, so data from elsewhere never becomes a formula. Today's
  rows keep working. `createXlsx` takes the same cells and a sheet's `header` ([Editing Office files](../docs/office.md#new-files)).
- **`documents create` makes bold and italic text and tables.** `--payload` also takes `{"text", "bold", "italic"}`,
  `{"runs": [{"text": "grew", "bold": true}]}` and `{"table": [["Item", "Cost"], ["Rent", "950"]], "header": true}`.
  Today's `[{"text", "style"}]` keeps working, and `createDocx` takes the same entries.
