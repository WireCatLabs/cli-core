### Added

- **A records file can be a spreadsheet.** `recordColumns(type)` lists a type's columns: `external_id`, its flat
  fields, one per role and one per key of its lists (`lines.amount`), each with whether it is required, its shape and
  its values. `recordTemplate(type, "csv" | "json")` writes a file to fill: the CSV header with a byte-order mark, in
  the separator asked for, or an envelope of one example record. `envelopeOfCsv(text, { type, source })` reads a sheet
  of one type as an envelope: `;`, `,` or a tab, a byte-order mark, `10 000,50` and `09.11.2026` as Excel writes them
  in Russian or Spanish, a role as the target's external id (`<type>:<external id>` where it takes several types), and
  a row that repeats an external id as one more item of a list. `placeOf(pointer)` names the line and column a
  receipt's pointer came from; a sheet it cannot read throws a `TableError` that names them too. SMS and calls have no
  table: they come from a phone's own export.
