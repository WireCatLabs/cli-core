### Fixed

- `search all` and `deals list` find a CRM record whose Cyrillic name is typed in Latin: `finpoint` and `finpoynt` find
  ФинПоинт, marked as corrected to `финпоинт`. Only a Cyrillic spelling the store holds as it is counts, so `cement`
  does not turn into цемент. Message search reads a Latin word the same way (#3285).
