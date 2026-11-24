### Fixed

- `search all` and `deals list` find a CRM record whose name is one letter off a query word that matched another
  record: `Ferrara` finds Ferrara Design first and Ferraro Arredamenti after it, marked as a correction. A misspelt
  word was corrected only when it matched nothing, so a near-duplicate hid the record asked for (#3285).
