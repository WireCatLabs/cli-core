### Fixed

- **A message search for «домен» no longer finds «дом» and «дома».** Snowball cuts some words to another word's stem.
  When a query word's stem is under 4 letters, drops 2 or more letters, and the stored stems show the whole word is a
  stem itself («доменов» → «домен»), the search keeps the word whole. The stems stored for messages do not change.
