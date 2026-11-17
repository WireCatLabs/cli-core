### Fixed

- **A message search for a word of 4 letters or more also finds the longer words it begins, as grep does.** Snowball
  stems some forms of one word apart («ростислав» → «ростисла», «ростислава» → «ростислав»), so a search found only the
  forms that shared the typed word's stem. Quotes keep the old match: the word and its stem's forms only. The note now
  says what was searched: `квартира → квартира… and words stemmed to квартир`.
