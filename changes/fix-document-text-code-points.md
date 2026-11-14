### Fixed

- **`documents show` says more text follows after emoji.** `has_more` compared the part's length in UTF-16 units
  with the whole text's length in code points, so a part holding emoji, or another character outside the Basic
  Multilingual Plane, could report no more text before the end and a reader stopped early. `text_offset`,
  `text_length`, `--cursor` and `--max-chars` all count Unicode code points: the next part starts at `text_offset`
  plus the code points of `text` (`[...text].length` in JavaScript, not `text.length`), and a part never splits a
  surrogate pair. A combining mark is a code point of its own, so a cut may fall between a letter and its accent.
