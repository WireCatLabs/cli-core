### Fixed

- **`search all` finds deals and leads by any form of a word, and by their company and contacts.** A query word
  matches a stored word it begins or one of the same stem, so «поставки цемента» finds «Поставка цемента» and
  `repairs` finds `Forklift repair`. A deal's or a lead's company name and its contacts' names, e-mails and phones are
  searched too, never the owner's, and a CRM copy only by what its own CRM holds of them, so a locked profile learns
  nothing of a person's other accounts; `+79161234567` finds `+7 916 123-45-67`. `found_by` stays `title` when the title
  matched and is `words` when only the company or a contact did. `deals.find` gives each hit's `matched` parts. See
  [ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md).
- **A misspelt CRM search is corrected once.** When nothing matches as typed, a word is corrected to the nearest
  stored words, as messages search does, and those hits carry `match: "corrected"` and `corrections`. `--exact` turns
  forms, word beginnings and correction off.

### Changed — may break callers

- **CRM search no longer matches inside a word.** `cement` no longer finds `replacement`, nor «кто» «Вектор». A query
  word shorter than four letters matches only a whole word.
- **`search all stage:won` skips deals and leads with the reason** instead of finding none and calling the answer
  complete; so do `status:` and `pipeline:`. `deals list stage:<name>` lists them by stage.
