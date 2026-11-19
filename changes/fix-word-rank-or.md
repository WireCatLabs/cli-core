### Fixed

- **A question searched by words is ranked by relevance again when one of its words cannot rank.** A word shorter than
  three letters next to longer ones, or a word start no indexed word has, dropped the relevance score of the whole
  question, and its matches came newest first. The ranking now uses the words it can; which messages match is
  unchanged.
