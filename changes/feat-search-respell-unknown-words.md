### Added

- **`search conversations` respells a query word that no message holds.** It searches the word's Latin spelling
  («ноксвел» → `noxvel`) or the nearest known spellings of that, and only when there are none, the word's own nearest
  known spellings, up to two edits. A word any message holds is never respelled. `meta.respelled` and a note say what
  was searched instead.
