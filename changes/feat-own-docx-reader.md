### Changed — may break callers

- **Word files are read by cli-core's own reader, and `mammoth` is no longer a dependency.** The install is 8 MB and
  24 packages smaller (273 MB instead of 281 MB for a bare install of the package). The text is the one mammoth gave:
  paragraphs, headings, list items and table cells, each followed by a blank line, no footnotes. Two things differ: a
  line break inside a paragraph is now a new line (mammoth joined the words on either side), and a simple field's
  shown value, a page number for one, is kept. The extractor is `docx:v1`; text read earlier keeps
  `docx:mammoth@1.13.0` and is not read again. `Engine` no longer has `"mammoth"`, and `doctor` no longer lists it, so a
  `Record<Engine, …>` with a `mammoth` key fails to typecheck: drop the key. A `.docx` never gives `engine-missing`
  now; a damaged one gives `unreadable`, as before. A CLI that depended on `mammoth` only for cli-core's reader can
  remove it.
